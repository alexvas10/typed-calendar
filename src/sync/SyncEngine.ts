import { App, Notice } from "obsidian";
import { CalDavClient } from "./caldav";
import { eventToICS, icsToEvent, ParsedVEvent, patchICS } from "./ics";
import {
	mergeRemote,
	newEventFromRemote,
	planSync,
	resourcesNeedingFetch,
	SyncAction,
	unsupportedMarker,
} from "./plan";
import { CalendarRouter } from "./routing";
import { CalendarEvent, ProviderKey, isLocked } from "../model/types";
import { generateUid } from "../model/serialize";
import { writeEventNote } from "../index/writer";
import {
	backfillTypes,
	backupConflict,
	dropLink,
	excludeLink,
	hasUnpushedEdits,
	realignLink,
	stampLink,
	uidsOnDisk,
} from "./notes";
import { ProviderEngine } from "./ProviderEngine";
import { RunContext, SyncReport, emptyReport, isWrite, newRunContext } from "./run";
import type TypedCalendarPlugin from "../../main";

export type { SyncReport } from "./run";

const MULTIGET_BATCH = 50;

export class SyncEngine {
	private running = false;

	constructor(
		private app: App,
		private plugin: TypedCalendarPlugin
	) {}

	get isRunning(): boolean {
		return this.running;
	}

	client(): CalDavClient {
		const { caldav } = this.plugin.settings;
		if (!caldav.username || !caldav.password) {
			throw new Error("Add your Apple ID and app-specific password in settings first.");
		}
		return new CalDavClient(caldav.serverUrl, caldav.username, caldav.password);
	}

	/**
	 * Runs a full pass over every enabled calendar on every connected service:
	 * iCloud first, then Google, then Outlook. Errors are collected per
	 * calendar rather than thrown, so one unreachable calendar does not abandon
	 * the others.
	 *
	 * The services never talk to each other. Each syncs against the notes, so a
	 * change pulled from iCloud reaches Google through its note -- on this run
	 * when the index has caught up, else on the next.
	 */
	async run(notify = true): Promise<SyncReport> {
		const report = emptyReport();
		if (this.running) {
			report.errors.push("A sync is already in progress.");
			return report;
		}

		const { caldav } = this.plugin.settings;
		const icloud = caldav.username && caldav.password ? caldav.calendars.filter((c) => c.enabled) : [];
		const remotes = this.plugin.remoteProviders();
		if (icloud.length === 0 && remotes.length === 0) {
			report.errors.push("No calendars are enabled for sync.");
			if (notify) new Notice("Typed Calendar: no calendars enabled for sync.");
			return report;
		}

		this.running = true;
		const ctx = newRunContext(this.plugin.settings.deleteMode);
		try {
			if (icloud.length > 0) {
				const client = this.client();
				const router = new CalendarRouter(this.plugin.settings.eventTypes, caldav.fallbackCalendar);
				// Uids written during this run. The index is fed by metadataCache,
				// which updates asynchronously, so a stamp written while syncing one
				// calendar is not visible when the next one is planned.
				const claimed = new Set<string>();
				for (const calendar of icloud) {
					try {
						await this.syncCalendar(client, calendar.url, calendar.readOnly, router, report, claimed, ctx);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						report.errors.push(`iCloud · ${calendar.displayName}: ${message}`);
						console.error("Typed Calendar: sync failed", calendar.url, error);
					}
				}
			}
			for (const provider of remotes) {
				const engine = new ProviderEngine(this.app, this.plugin, provider, ctx, (event, r) =>
					this.onVanished(event, provider.key, ctx, r)
				);
				await engine.run(report);
			}
			await this.resolveVanished(ctx, report);
			this.plugin.settings.caldav.lastSync = new Date().toISOString();
			await this.plugin.saveSettings();
		} finally {
			this.running = false;
		}

		if (notify) new Notice(describe(report));
		return report;
	}

	/**
	 * An event is gone from a calendar it was linked to -- deleted on a phone,
	 * or in the service's own app. Under the default setting it leaves that
	 * service only and is not sent back; under "delete everywhere" it is
	 * queued, and decided once the whole run has seen where it might have gone.
	 * A locked event is never deleted this way, only kept out.
	 */
	private async onVanished(event: CalendarEvent, key: ProviderKey, ctx: RunContext, report: SyncReport): Promise<void> {
		if (ctx.deleteMode === "this-calendar" || isLocked(event)) {
			await excludeLink(this.app, event, key);
			report.unlinked++;
			return;
		}
		ctx.vanished.push({ event, key });
	}

	/**
	 * Carries out "delete everywhere" for events that went missing this run. One
	 * that turned up in another calendar on the same service was moved, not
	 * deleted: its dead link is dropped so that calendar's next pass adopts it.
	 */
	private async resolveVanished(ctx: RunContext, report: SyncReport): Promise<void> {
		for (const { event, key } of ctx.vanished) {
			try {
				if (ctx.seen[key].has(event.uid)) {
					await dropLink(this.app, event, key);
					report.unlinked++;
					continue;
				}
				await this.plugin.deleteEverywhere(event, key);
				report.deleted++;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				report.errors.push(`Deleting "${event.title}" everywhere: ${message}`);
				// Whatever else failed, it stays out of the service it left.
				await excludeLink(this.app, event, key);
			}
		}
	}

	private async syncCalendar(
		client: CalDavClient,
		calendarUrl: string,
		readOnly: boolean,
		router: CalendarRouter,
		report: SyncReport,
		claimed: Set<string>,
		ctx: RunContext
	): Promise<void> {
		// Events bound elsewhere are filtered out by the planner; unbound ones
		// are candidates only if they route here, which the planner decides.
		const all = this.plugin.index.all();
		const localEvents = all.filter(
			(event) => !event.icloud?.href || event.icloud.collection === calendarUrl
		);
		// Every uid in the vault, so a resource whose note is bound to another
		// calendar is never adopted as a second note for the same event.
		const knownUids = uidsOnDisk(this.app);
		for (const event of all) if (event.uid) knownUids.add(event.uid);
		for (const uid of claimed) knownUids.add(uid);

		const remoteResources = await client.listResources(calendarUrl);
		const stale = resourcesNeedingFetch(localEvents, remoteResources);

		const timezone = this.plugin.settings.defaultTimezone;
		const fetched = new Map<string, ParsedVEvent>();
		for (let i = 0; i < stale.length; i += MULTIGET_BATCH) {
			const batch = stale.slice(i, i + MULTIGET_BATCH);
			for (const object of await client.multiget(calendarUrl, batch)) {
				const parsed = icsToEvent(object.data, timezone);
				if (parsed) {
					fetched.set(object.href, parsed);
					ctx.seen.icloud.add(parsed.uid);
				}
			}
		}

		const actions = planSync({
			localEvents,
			remoteResources,
			fetched,
			calendarUrl,
			routeFor: (event) => router.routeFor(event),
			knownUids,
			claimedUids: claimed,
		});
		for (const action of actions) {
			if (readOnly && isWrite(action)) continue;
			// Claim before executing, not after: a throw halfway through a move
			// still leaves the resource written, and a later pass in the same run
			// must not treat it as a new event.
			if ("event" in action && action.event.uid) claimed.add(action.event.uid);
			await this.execute(client, calendarUrl, action, router, report, ctx);
		}

		report.typed += await backfillTypes(this.app, this.plugin.index.all(), "icloud", calendarUrl, router, claimed);
	}


	private async execute(
		client: CalDavClient,
		calendarUrl: string,
		action: SyncAction,
		router: CalendarRouter,
		report: SyncReport,
		ctx: RunContext
	): Promise<void> {
		const folder = this.plugin.settings.eventFolder;
		switch (action.kind) {
			case "create-local": {
				const event = newEventFromRemote(
					action.remote, "icloud", action.href, action.etag, calendarUrl,
					(existing) => router.withCalendarType(existing, calendarUrl),
					this.plugin.settings.defaultTimezone, action.remote.uid || generateUid()
				);
				const created = await writeEventNote(this.app, folder, event, true);
				// writeEventNote stamps localModified as "now", which would look
				// like a local edit on the next pass; realign it to the remote.
				await realignLink(this.app, created, "icloud", action.remote.remoteModified);
				report.pulled++;
				break;
			}
			case "update-local": {
				if (hasUnpushedEdits(action.event.icloud)) {
					await backupConflict(this.app, folder, action.event);
					report.conflicts++;
				}
				const merged = mergeRemote(
					action.event, action.remote, action.href, action.etag, calendarUrl,
					(existing) => router.withCalendarType(existing, calendarUrl)
				);
				// Rewriting the note marks the Google and Outlook copies stale, which
				// is how this change reaches them on their passes.
				const updated = await writeEventNote(this.app, folder, merged, false);
				await realignLink(this.app, updated, "icloud", action.remote.remoteModified);
				report.pulled++;
				break;
			}
			case "create-remote": {
				await this.push(client, calendarUrl, action.event, true);
				report.pushed++;
				break;
			}
			case "update-remote": {
				if (await this.push(client, calendarUrl, action.event, false)) report.pushed++;
				else report.unchanged++;
				break;
			}
			case "delete-remote": {
				const href = action.event.icloud?.href;
				if (href) await client.delete(href, action.event.icloud?.etag);
				await dropLink(this.app, action.event, "icloud");
				report.deleted++;
				break;
			}
			case "move-remote": {
				// No MOVE in CalDAV, so this is a delete plus a create, and the
				// ORIGINAL body is carried across (patched) rather than
				// regenerated so alarms and rules survive the trip.
				//
				// The delete has to come first. Creating first and deleting
				// after would be the safer order -- a failed delete leaves a
				// recoverable duplicate -- but iCloud enforces UID uniqueness
				// across the entire calendar home, so the create is refused with
				// 412 for as long as the source copy exists. Verified against the
				// real account: a different href does not help either.
				const href = action.event.icloud?.href;
				if (!href) break;
				const [current] = await client.multiget(action.from, [href]);
				if (!current) {
					// The source is already gone: an earlier move was interrupted
					// between its delete and its create. There is nothing left to
					// carry, so drop the dead link and let the next pass create the
					// event in the calendar it now routes to.
					await dropLink(this.app, action.event, "icloud");
					report.unlinked++;
					break;
				}
				const patched = patchICS(
					current.data, action.event, this.plugin.settings.defaultTimezone
				);
				if (!patched || patched.pullOnly) {
					throw new Error(`Not moving "${action.event.title}": could not safely copy it.`);
				}
				const relocated: CalendarEvent = {
					...action.event,
					icloud: { ...action.event.icloud, href: undefined, etag: undefined },
				};
				await client.delete(href, current.etag);
				try {
					await this.push(client, action.to, relocated, true, patched.ics);
				} catch (error) {
					// The source is gone and the destination refused it. Unlink so
					// the note stops pointing at a resource that no longer exists
					// and is simply created again next pass; the note itself, which
					// is what the user wrote, is never touched.
					await dropLink(this.app, action.event, "icloud");
					throw error;
				}
				report.moved++;
				break;
			}
			case "unlink-local": {
				// Gone from iCloud: the deletion setting decides what that means.
				await this.onVanished(action.event, "icloud", ctx, report);
				break;
			}
		}
	}

	/**
	 * Writes an event to iCloud.
	 *
	 * A new event is generated from the note. An existing one is never
	 * regenerated: the server copy is fetched fresh and patched in place, so
	 * alarms, recurrence and everything else the plugin does not model
	 * survive. If that copy cannot be read or patched, nothing is written --
	 * falling back to a regenerated body is what destroyed a calendar once.
	 *
	 * `seed` supplies the body for a move, which carries the original across.
	 *
	 * Returns whether anything was actually written: a planned update can turn
	 * out to be a no-op once compared against the server copy.
	 */

	private async push(
		client: CalDavClient,
		calendarUrl: string,
		event: CalendarEvent,
		isNew: boolean,
		seed?: string
	): Promise<boolean> {
		const timezone = this.plugin.settings.defaultTimezone;
		const href = event.icloud?.href ?? `${calendarUrl.replace(/\/?$/, "/")}${event.uid}.ics`;

		if (isNew) {
			const ics = seed ?? eventToICS(event, timezone);
			await client.put(href, ics);
			await this.readBackAndStamp(client, calendarUrl, href, event);
			return true;
		}

		const [current] = await client.multiget(calendarUrl, [href]);
		if (!current) throw new Error(`"${event.title}" is gone from the server.`);

		const patched = patchICS(current.data, event, timezone);
		if (!patched) {
			throw new Error(`Not writing "${event.title}": could not read the copy on the server.`);
		}
		if (!patched.changed) {
			// Nothing to send. Record the server's state so the next pass does
			// not see a stale ETag and revisit it.
			const parsed = icsToEvent(current.data, timezone);
			await stampLink(this.app, event, "icloud", {
				href,
				etag: current.etag,
				remoteModified: parsed?.remoteModified,
				collection: calendarUrl,
				recurring: patched.recurring,
			});
			return false;
		}

		// If-Match on the ETag we just fetched: a 412 here means someone wrote
		// in the last few milliseconds, and the next pass re-plans.
		await client.put(href, patched.ics, current.etag);
		await this.readBackAndStamp(client, calendarUrl, href, event);
		return true;
	}

	/** ETags are not reliably returned on PUT, so read the resource back. */
	private async readBackAndStamp(
		client: CalDavClient,
		calendarUrl: string,
		href: string,
		event: CalendarEvent
	): Promise<void> {
		const [written] = await client.multiget(calendarUrl, [href]);
		const parsed = written ? icsToEvent(written.data, this.plugin.settings.defaultTimezone) : null;
		await stampLink(this.app, event, "icloud", {
			href,
			etag: written?.etag ?? "",
			remoteModified: parsed?.remoteModified,
			collection: calendarUrl,
			recurring: parsed?.recurring,
			unsupportedRule: unsupportedMarker(parsed),
		});
	}
}


function describe(report: SyncReport): string {
	if (report.errors.length > 0) {
		return `Typed Calendar: sync finished with problems — ${report.errors[0]}`;
	}
	const parts: string[] = [];
	if (report.pulled) parts.push(`${report.pulled} in`);
	if (report.pushed) parts.push(`${report.pushed} out`);
	if (report.deleted) parts.push(`${report.deleted} removed`);
	if (report.moved) parts.push(`${report.moved} moved`);
	if (report.typed) parts.push(`${report.typed} typed`);
	if (report.unchanged) parts.push(`${report.unchanged} already current`);
	if (report.unlinked) parts.push(`${report.unlinked} unlinked`);
	if (report.conflicts) parts.push(`${report.conflicts} conflict(s) backed up`);
	if (report.skipped) parts.push(`${report.skipped} not supported by a service`);
	return parts.length > 0
		? `Typed Calendar: synced (${parts.join(", ")}).`
		: "Typed Calendar: already up to date.";
}
