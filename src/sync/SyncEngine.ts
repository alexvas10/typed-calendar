import { App, Notice, TFile, normalizePath } from "obsidian";
import { CalDavClient, CalDavError } from "./caldav";
import { eventToICS, icsToEvent, ParsedVEvent, patchICS } from "./ics";
import { mergeRemote, planSync, resourcesNeedingFetch, SyncAction } from "./plan";
import { CalendarRouter } from "./routing";
import { CalendarEvent } from "../model/types";
import { generateUid } from "../model/serialize";
import { writeEventNote } from "../index/writer";
import type TypedCalendarPlugin from "../../main";

export interface SyncReport {
	pulled: number;
	pushed: number;
	deleted: number;
	moved: number;
	/** Events given their calendar's type. A local edit only; nothing is sent. */
	typed: number;
	/** Planned pushes that matched the server copy and sent nothing. */
	unchanged: number;
	unlinked: number;
	conflicts: number;
	errors: string[];
}

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
	 * Runs a full pass over every enabled calendar. Errors are collected per
	 * calendar rather than thrown, so one unreachable collection does not
	 * abandon the others.
	 */
	async run(notify = true): Promise<SyncReport> {
		const report: SyncReport = {
			pulled: 0, pushed: 0, deleted: 0, moved: 0, typed: 0, unchanged: 0, unlinked: 0, conflicts: 0, errors: [],
		};
		if (this.running) {
			report.errors.push("A sync is already in progress.");
			return report;
		}

		const enabled = this.plugin.settings.caldav.calendars.filter((c) => c.enabled);
		if (enabled.length === 0) {
			report.errors.push("No calendars are enabled for sync.");
			if (notify) new Notice("Typed Calendar: no calendars enabled for sync.");
			return report;
		}

		this.running = true;
		try {
			const client = this.client();
			const router = new CalendarRouter(
				this.plugin.settings.eventTypes,
				this.plugin.settings.caldav.fallbackCalendar
			);
			// Uids written during this run. The index is fed by metadataCache,
			// which updates asynchronously, so a stamp written while syncing one
			// calendar is not visible when the next one is planned.
			const claimed = new Set<string>();
			for (const calendar of enabled) {
				try {
					await this.syncCalendar(
						client, calendar.url, calendar.readOnly, router, report, claimed
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					report.errors.push(`${calendar.displayName}: ${message}`);
					console.error("Typed Calendar: sync failed", calendar.url, error);
				}
			}
			this.plugin.settings.caldav.lastSync = new Date().toISOString();
			await this.plugin.saveSettings();
		} finally {
			this.running = false;
		}

		if (notify) new Notice(describe(report));
		return report;
	}

	private async syncCalendar(
		client: CalDavClient,
		calendarUrl: string,
		readOnly: boolean,
		router: CalendarRouter,
		report: SyncReport,
		claimed: Set<string>
	): Promise<void> {
		// Events bound elsewhere are filtered out by the planner; unbound ones
		// are candidates only if they route here, which the planner decides.
		const all = this.plugin.index.all();
		const localEvents = all.filter(
			(event) => !event.icloud?.href || event.icloud.collection === calendarUrl
		);
		// Every uid in the vault, so a resource whose note is bound to another
		// calendar is never adopted as a second note for the same event.
		const knownUids = this.uidsOnDisk();
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
				// Recurring series are rendered from the server copy but not
				// authored here yet, so they are pulled and never pushed back.
				if (parsed) fetched.set(object.href, parsed);
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
			await this.execute(client, calendarUrl, action, router, report);
		}

		await this.backfillTypes(calendarUrl, router, report, claimed);
	}

	/**
	 * Every uid written in a note, read from the file list rather than from the
	 * index.
	 *
	 * Deliberately a second source: the index drops its entry for the old path
	 * the instant a file is renamed, so for a moment an event exists on disk but
	 * not in the map -- and a resource whose note is "missing" gets adopted as a
	 * brand new event. Scanning files finds it under whichever path the cache
	 * still knows.
	 */
	private uidsOnDisk(): Set<string> {
		const uids = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const uid = this.app.metadataCache.getFileCache(file)?.frontmatter?.uid;
			if (typeof uid === "string" && uid) uids.add(uid);
		}
		return uids;
	}

	private async execute(
		client: CalDavClient,
		calendarUrl: string,
		action: SyncAction,
		router: CalendarRouter,
		report: SyncReport
	): Promise<void> {
		switch (action.kind) {
			case "create-local": {
				const event = this.eventFromRemote(
					action.remote, action.href, action.etag, calendarUrl, router
				);
				const created = await writeEventNote(
					this.app, this.plugin.settings.eventFolder, event, true
				);
				// writeEventNote stamps localModified as "now", which would look
				// like a local edit on the next pass; realign it to the remote.
				await this.realign(created, action.remote.remoteModified);
				report.pulled++;
				break;
			}
			case "update-local": {
				if (hasUnpushedEdits(action.event)) {
					await this.backupConflict(action.event);
					report.conflicts++;
				}
				const merged = mergeRemote(
					action.event, action.remote, action.href, action.etag, calendarUrl,
					(existing) => router.withCalendarType(existing, calendarUrl)
				);
				const updated = await writeEventNote(
					this.app, this.plugin.settings.eventFolder, merged, false
				);
				await this.realign(updated, action.remote.remoteModified);
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
				await this.unlink(action.event);
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
					await this.unlink(action.event);
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
					await this.unlink(action.event);
					throw error;
				}
				report.moved++;
				break;
			}
			case "unlink-local": {
				await this.unlink(action.event);
				report.unlinked++;
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
	/**
	 * Gives events already in the vault the type of the calendar they belong
	 * to. Pulling only types an event when it is downloaded, so without this a
	 * mapping made after the first sync would never reach existing events.
	 *
	 * Edits `types` alone and leaves the sync stamps untouched, so it is
	 * invisible to the planner and cannot cause a push.
	 */
	private async backfillTypes(
		calendarUrl: string,
		router: CalendarRouter,
		report: SyncReport,
		claimed: Set<string>
	): Promise<void> {
		for (const event of this.plugin.index.all()) {
			if (event.icloud?.collection !== calendarUrl) continue;
			// This run already wrote this event somewhere, so the binding in the
			// index is not necessarily current. An event that has just been moved
			// out still reads as belonging here, and typing it would hand back the
			// very type the user removed to move it in the first place.
			if (claimed.has(event.uid)) continue;
			const next = router.withCalendarType(event.types, calendarUrl);
			if (next === event.types) continue;

			const file = this.app.vault.getAbstractFileByPath(event.path);
			if (!(file instanceof TFile)) continue;
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				fm.types = next;
			});
			report.typed++;
		}
	}

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
			await this.stampSync(event, {
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
		await this.stampSync(event, {
			href,
			etag: written?.etag ?? "",
			remoteModified: parsed?.remoteModified,
			collection: calendarUrl,
			recurring: parsed?.recurring,
			unsupportedRule: parsed ? parsed.recurring && !parsed.recurrence : undefined,
		});
	}

	private eventFromRemote(
		remote: ParsedVEvent,
		href: string,
		etag: string,
		calendarUrl: string,
		router: CalendarRouter
	): CalendarEvent {
		return {
			uid: remote.uid || generateUid(),
			title: remote.title,
			// A pulled event carries no types of its own, so the calendar it
			// came from supplies one.
			types: router.withCalendarType(remote.types ?? [], calendarUrl),
			date: remote.date,
			recurrence: remote.recurrence,
			exceptions: remote.recurrence ? remote.exceptions : undefined,
			startTime: remote.startTime,
			endTime: remote.endTime,
			allDay: remote.allDay,
			location: remote.location,
			description: remote.description,
			timezone: this.plugin.settings.defaultTimezone,
			status: "confirmed",
			props: remote.props ?? {},
			icloud: {
				collection: calendarUrl,
				href,
				etag,
				remoteModified: remote.remoteModified,
				localModified: remote.remoteModified,
				recurring: remote.recurring || undefined,
				unsupportedRule: remote.recurring && !remote.recurrence ? true : undefined,
			},
			path: "",
		};
	}

	/** Writes sync bookkeeping onto the note without touching its content. */
	private async stampSync(
		event: CalendarEvent,
		meta: {
			href: string;
			etag: string;
			remoteModified?: string;
			collection?: string;
			recurring?: boolean;
			unsupportedRule?: boolean;
		}
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(event.path);
		if (!(file instanceof TFile)) return;
		const stamp = meta.remoteModified ?? new Date().toISOString();
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			const icloud: Record<string, unknown> = {
				...(fm.icloud as object),
				collection: meta.collection ?? event.icloud?.collection,
				href: meta.href,
				etag: meta.etag,
				remoteModified: stamp,
				localModified: stamp,
				recurring: meta.recurring || undefined,
				unsupportedRule: meta.unsupportedRule || undefined,
			};
			// A key set to undefined would serialise as an empty YAML value
			// rather than disappearing, and an empty `recurring:` reads as
			// truthy nowhere but looks alarming in the note.
			for (const [key, value] of Object.entries(icloud)) {
				if (value === undefined) delete icloud[key];
			}
			fm.icloud = icloud;
		});
	}

	/**
	 * Realigns the local stamp to the remote one after a pull, so the next
	 * pass does not mistake the write we just made for a user edit.
	 *
	 * Takes the file writeEventNote returned rather than looking it up: a
	 * freshly created note is not in the index yet, because metadataCache
	 * updates asynchronously, and the lookup would silently find nothing.
	 */
	private async realign(file: TFile, remoteModified?: string): Promise<void> {
		const stamp = remoteModified ?? new Date().toISOString();
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm.icloud = { ...(fm.icloud as object), remoteModified: stamp, localModified: stamp };
		});
	}

	/** Drops the server link, leaving the note itself untouched. */
	private async unlink(event: CalendarEvent): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(event.path);
		if (!(file instanceof TFile)) return;
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			delete fm.icloud;
		});
	}

	/**
	 * Copies the about-to-be-overwritten local version into a conflicts
	 * folder. Last-edit-wins is only safe if the loser is recoverable.
	 */
	private async backupConflict(event: CalendarEvent): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(event.path);
		if (!(file instanceof TFile)) return;
		const folder = normalizePath(`${this.plugin.settings.eventFolder}/.conflicts`);
		try {
			if (!this.app.vault.getAbstractFileByPath(folder)) {
				await this.app.vault.createFolder(folder);
			}
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const contents = await this.app.vault.read(file);
			await this.app.vault.create(`${folder}/${file.basename} ${stamp}.md`, contents);
		} catch (error) {
			console.error("Typed Calendar: could not back up conflicting event", error);
		}
	}
}

function isWrite(action: SyncAction): boolean {
	return (
		action.kind === "create-remote" ||
		action.kind === "update-remote" ||
		action.kind === "delete-remote"
	);
}

/** True when the note changed after the last successful push. */
function hasUnpushedEdits(event: CalendarEvent): boolean {
	const local = Date.parse(event.icloud?.localModified ?? "");
	const remote = Date.parse(event.icloud?.remoteModified ?? "");
	if (isNaN(local) || isNaN(remote)) return false;
	return local > remote;
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
	return parts.length > 0
		? `Typed Calendar: synced (${parts.join(", ")}).`
		: "Typed Calendar: already up to date.";
}
