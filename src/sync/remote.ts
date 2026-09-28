import { CalendarEvent, OccurrenceOverride, ProviderKey } from "../model/types";
import { activeOverrides, applyOverride } from "../model/occurrences";
import { ParsedVEvent } from "./ics";
import { sameRule } from "./rrule";
import { fromMinutes, toMinutes } from "../util/clock";

/**
 * The contract a calendar service implements to sync through the shared
 * planner. iCloud predates it and has its own engine (SyncEngine); Google and
 * Outlook implement this.
 *
 * Every service is normalised to `ParsedVEvent` on the way in -- the same
 * shape the iCloud reader produces -- so the planner, the conflict rules and
 * `mergeRemote` are shared rather than re-derived per service.
 */

export interface RemoteCalendarInfo {
	id: string;
	name: string;
	/** The account cannot write to it (a shared calendar, subscriptions). */
	readOnly: boolean;
}

/** One event as a service holds it, normalised. */
export interface RemoteItem {
	/** The service's id for the event: the link's `href`. */
	id: string;
	/**
	 * A version that changes whenever anything about the event changes,
	 * including one of its occurrences. Compared against the link's `etag` to
	 * decide what to re-read.
	 */
	etag: string;
	event: ParsedVEvent;
	/** Service-specific data the writer needs again (instance ids and so on). */
	raw?: unknown;
}

export interface RemoteProvider {
	readonly key: Exclude<ProviderKey, "icloud">;
	readonly label: string;
	/** The signed-in account's address, shown in settings. */
	accountName(): Promise<string>;
	listCalendars(): Promise<RemoteCalendarInfo[]>;
	/** Every event in the calendar, normalised. */
	listEvents(calendarId: string, timezone: string): Promise<RemoteItem[]>;
	/**
	 * Why this event cannot be written to this service, or null when it can.
	 * An event the service cannot represent -- a rule Outlook has no pattern
	 * for -- is left out of it rather than flattened into something else.
	 */
	unsupported(event: CalendarEvent): string | null;
	create(calendarId: string, event: CalendarEvent, timezone: string): Promise<string>;
	/**
	 * Writes only what differs from `current`. Returns false when the service
	 * already matches, so a planned update can cost no write at all.
	 */
	update(calendarId: string, current: RemoteItem, event: CalendarEvent, timezone: string): Promise<boolean>;
	/** Moves to another calendar; returns the event's id there. */
	move(from: string, to: string, current: RemoteItem, event: CalendarEvent, timezone: string): Promise<string>;
	delete(calendarId: string, id: string): Promise<void>;
}

/** The end time a writer would use: the note's, or an hour after the start. */
export function effectiveEnd(startTime: string, endTime: string | undefined): string {
	return endTime ?? fromMinutes(toMinutes(startTime) + 60);
}

/** True when the remote copy's own fields (not its rule) match the note. */
export function sameMaster(remote: ParsedVEvent, event: CalendarEvent): boolean {
	const timed = !event.allDay && Boolean(event.startTime);
	const text = (a: string | undefined, b: string | undefined) => (a ?? "").trim() === (b ?? "").trim();
	if (remote.date !== event.date || remote.allDay === timed) return false;
	if (timed) {
		const start = event.startTime as string;
		if (remote.startTime !== start) return false;
		if ((remote.endTime ?? effectiveEnd(start, undefined)) !== effectiveEnd(start, event.endTime)) {
			return false;
		}
	}
	return (
		text(remote.title, event.title) &&
		text(remote.location, event.location) &&
		text(remote.description, event.description)
	);
}

/** True when the rule and skipped dates match. */
export function sameRepeat(remote: ParsedVEvent, event: CalendarEvent, timezone: string): boolean {
	const allDay = event.allDay || !event.startTime;
	if (!sameRule(remote.recurrence, event.recurrence, timezone, allDay)) return false;
	const wanted = event.recurrence ? [...(event.exceptions ?? [])].sort() : [];
	return wanted.join(",") === [...(remote.exceptions ?? [])].sort().join(",");
}

/** True when the vault-owned mirror (types, custom fields) is already there. */
export function sameMirror(remote: ParsedVEvent, event: CalendarEvent): boolean {
	const types = (remote.types ?? []).join(",") === event.types.join(",");
	const props = JSON.stringify(remote.props ?? {}) === JSON.stringify(event.props);
	return types && props;
}

export interface OverridePlan {
	/** Occurrences to write, as they should look. */
	write: OccurrenceOverride[];
	/**
	 * Occurrences the service has changed but the note no longer lists: put
	 * back in line with the series. Only an entry gone from the note counts --
	 * one still listed but inert is left alone, as for iCloud.
	 */
	reset: string[];
}

/** Which occurrences differ between the service and the note. */
export function planOverrides(remote: ParsedVEvent, event: CalendarEvent): OverridePlan {
	const current = new Map((remote.overrides ?? []).map((o) => [o.occurrence, o]));
	const listed = new Set((event.overrides ?? []).map((o) => o.occurrence));
	const write: OccurrenceOverride[] = [];
	for (const override of activeOverrides(event)) {
		const existing = current.get(override.occurrence);
		const want = applyOverride(event, override.occurrence, override);
		const have = existing ? applyOverride({ ...event, ...seriesFields(remote) }, override.occurrence, existing) : null;
		if (!have || JSON.stringify(strip(want)) !== JSON.stringify(strip(have))) write.push(override);
	}
	const reset = [...current.keys()].filter((occurrence) => !listed.has(occurrence));
	return { write, reset };
}

/** The series-level fields of a remote copy, to apply its overrides against. */
function seriesFields(remote: ParsedVEvent): Partial<CalendarEvent> {
	return {
		title: remote.title,
		allDay: remote.allDay,
		startTime: remote.startTime,
		endTime: remote.endTime,
		location: remote.location,
		description: remote.description,
	};
}

/** An occurrence minus the bookkeeping that is not part of what it looks like. */
function strip(occurrence: ReturnType<typeof applyOverride>) {
	const { override: _override, ...rest } = occurrence;
	// A note may leave the end out ("an hour"); the service always has one.
	if (!rest.allDay && rest.startTime) rest.endTime = effectiveEnd(rest.startTime, rest.endTime);
	rest.title = rest.title.trim();
	for (const key of ["location", "description"] as const) {
		rest[key] = (rest[key] ?? "").trim() || undefined;
	}
	return rest;
}
