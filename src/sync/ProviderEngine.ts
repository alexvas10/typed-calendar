import { App } from "obsidian";
import { CALENDAR_FIELD, CalendarEvent, PROVIDER_LABELS } from "../model/types";
import { generateUid } from "../model/serialize";
import { writeEventNote } from "../index/writer";
import {
	bindingFor,
	mergeRemote,
	newEventFromRemote,
	planSync,
	resourcesNeedingFetch,
	SyncAction,
	unsupportedMarker,
} from "./plan";
import { CalendarRouter } from "./routing";
import { RemoteItem, RemoteProvider } from "./remote";
import {
	backfillTypes,
	backupConflict,
	dropLink,
	hasUnpushedEdits,
	realignLink,
	stampLink,
	uidsOnDisk,
} from "./notes";
import { RunContext, SyncReport, isWrite } from "./run";
import type TypedCalendarPlugin from "../../main";

/**
 * One sync pass for a service reached through `RemoteProvider` (Google,
 * Outlook). The same shape as SyncEngine's iCloud pass -- list, plan with the
 * shared planner, execute, restamp -- so the conflict rules, the duplicate
 * guards and the locks are the ones already proven on iCloud.
 */
export class ProviderEngine {
	private readonly key: RemoteProvider["key"];

	constructor(
		private app: App,
		private plugin: TypedCalendarPlugin,
		private provider: RemoteProvider,
		private ctx: RunContext,
		/** Hands a vanished event to the run's deletion policy. */
		private onVanished: (event: CalendarEvent, report: SyncReport) => Promise<void>
	) {
		this.key = provider.key;
	}

	async run(report: SyncReport): Promise<void> {
		const settings = this.plugin.settings[this.key];
		const router = new CalendarRouter(
			this.plugin.settings.eventTypes,
			settings.fallbackCalendar,
			CALENDAR_FIELD[this.key]
		);
		// Uids written during this pass; see SyncEngine.run.
		const claimed = new Set<string>();
		for (const calendar of settings.calendars.filter((c) => c.enabled)) {
			try {
				await this.syncCalendar(calendar.url, calendar.readOnly, router, report, claimed);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				report.errors.push(`${PROVIDER_LABELS[this.key]} · ${calendar.displayName}: ${message}`);
				console.error(`Typed Calendar: ${this.key} sync failed`, calendar.url, error);
			}
		}
	}

	private async syncCalendar(
		calendarId: string,
		readOnly: boolean,
		router: CalendarRouter,
		report: SyncReport,
		claimed: Set<string>
	): Promise<void> {
		const binding = bindingFor(this.key);
		const timezone = this.plugin.settings.defaultTimezone;
		const all = this.plugin.index.all();
		const localEvents = all.filter((event) => !binding(event)?.href || binding(event)?.collection === calendarId);
		const knownUids = uidsOnDisk(this.app);
		for (const event of all) if (event.uid) knownUids.add(event.uid);
		for (const uid of claimed) knownUids.add(uid);

		const items = await this.provider.listEvents(calendarId, timezone);
		const byId = new Map(items.map((item) => [item.id, item]));
		for (const item of items) this.ctx.seen[this.key].add(item.event.uid);

		const remoteResources = items.map((item) => ({ href: item.id, etag: item.etag }));
		const stale = new Set(resourcesNeedingFetch(localEvents, remoteResources, binding));
		const fetched = new Map(items.filter((item) => stale.has(item.id)).map((item) => [item.id, item.event]));

		const actions = planSync({
			localEvents,
			remoteResources,
			fetched,
			calendarUrl: calendarId,
			routeFor: (event) => router.routeFor(event),
			knownUids,
			claimedUids: claimed,
			binding,
		});

		// Events written this pass, by their id on the service: restamped with
		// the service's own version once the writes are done.
		const written = new Map<string, CalendarEvent>();
		for (const action of actions) {
			if (readOnly && isWrite(action)) continue;
			if ("event" in action && action.event.uid) claimed.add(action.event.uid);
			await this.execute(calendarId, action, router, byId, written, report);
		}

		if (written.size > 0) await this.restamp(calendarId, written);
		report.typed += await backfillTypes(this.app, this.plugin.index.all(), this.key, calendarId, router, claimed);
	}

	private async execute(
		calendarId: string,
		action: SyncAction,
		router: CalendarRouter,
		byId: Map<string, RemoteItem>,
		written: Map<string, CalendarEvent>,
		report: SyncReport
	): Promise<void> {
		const timezone = this.plugin.settings.defaultTimezone;
		const folder = this.plugin.settings.eventFolder;
		const addTypes = (types: string[]) => router.withCalendarType(types, calendarId);

		switch (action.kind) {
			case "create-local": {
				const event = newEventFromRemote(
					action.remote, this.key, action.href, action.etag, calendarId, addTypes,
					timezone, action.remote.uid || generateUid()
				);
				const file = await writeEventNote(this.app, folder, event, true);
				// writeEventNote stamps "now"; realign so this is not a local edit.
				await realignLink(this.app, file, this.key, action.remote.remoteModified);
				report.pulled++;
				break;
			}
			case "update-local": {
				if (hasUnpushedEdits(action.event[this.key])) {
					await backupConflict(this.app, folder, action.event);
					report.conflicts++;
				}
				const merged = mergeRemote(action.event, action.remote, action.href, action.etag, calendarId, addTypes, this.key);
				// Rewriting the note marks every *other* service's copy stale, which
				// is how this change reaches them on their own passes.
				const file = await writeEventNote(this.app, folder, merged, false);
				await realignLink(this.app, file, this.key, action.remote.remoteModified);
				report.pulled++;
				break;
			}
			case "create-remote": {
				const reason = this.provider.unsupported(action.event);
				if (reason) {
					// Not written, not excluded: if the rule changes to one this
					// service can hold, the next pass creates it.
					console.info(`Typed Calendar: "${action.event.title}" is not sent to ${this.provider.label}: ${reason}.`);
					report.skipped++;
					break;
				}
				const id = await this.provider.create(calendarId, action.event, timezone);
				written.set(id, action.event);
				report.pushed++;
				break;
			}
			case "update-remote": {
				const current = byId.get(action.event[this.key]?.href ?? "");
				if (!current) throw new Error(`"${action.event.title}" is gone from ${this.provider.label}.`);
				const reason = this.provider.unsupported(action.event);
				if (reason) {
					console.info(`Typed Calendar: "${action.event.title}" is not updated on ${this.provider.label}: ${reason}.`);
					report.skipped++;
					break;
				}
				if (await this.provider.update(calendarId, current, action.event, timezone)) {
					written.set(current.id, action.event);
					report.pushed++;
				} else {
					// Nothing to send; record the service's version so the next
					// pass does not revisit it.
					await stampLink(this.app, action.event, this.key, {
						href: current.id,
						etag: current.etag,
						remoteModified: current.event.remoteModified,
						collection: calendarId,
						recurring: current.event.recurring,
						unsupportedRule: unsupportedMarker(current.event),
					});
					report.unchanged++;
				}
				break;
			}
			case "delete-remote": {
				// The note lost its date or became TBD: off the service, link dropped,
				// so rescheduling it later creates it again.
				const href = action.event[this.key]?.href;
				if (href) await this.provider.delete(calendarId, href);
				await dropLink(this.app, action.event, this.key);
				report.deleted++;
				break;
			}
			case "move-remote": {
				const current = byId.get(action.event[this.key]?.href ?? "");
				if (!current) {
					// Already gone from the source: let the next pass create it where
					// it now belongs.
					await dropLink(this.app, action.event, this.key);
					report.unlinked++;
					break;
				}
				const id = await this.provider.move(action.from, action.to, current, action.event, timezone);
				// No version yet in the destination: an empty etag makes its next
				// pass read the event and settle the stamps.
				await stampLink(this.app, action.event, this.key, { href: id, etag: "", collection: action.to });
				report.moved++;
				break;
			}
			case "unlink-local": {
				await this.onVanished(action.event, report);
				break;
			}
		}
	}

	/** Records the service's version for events written this pass. */
	private async restamp(calendarId: string, written: Map<string, CalendarEvent>): Promise<void> {
		const timezone = this.plugin.settings.defaultTimezone;
		const fresh = new Map((await this.provider.listEvents(calendarId, timezone)).map((item) => [item.id, item]));
		for (const [id, event] of written) {
			const item = fresh.get(id);
			await stampLink(this.app, event, this.key, {
				href: id,
				// Unknown if the listing did not show it yet: the next pass re-reads.
				etag: item?.etag ?? "",
				remoteModified: item?.event.remoteModified,
				collection: calendarId,
				recurring: item?.event.recurring,
				unsupportedRule: item ? unsupportedMarker(item.event) : undefined,
			});
		}
	}
}
