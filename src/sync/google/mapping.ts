import { createHash } from "node:crypto";
import { CalendarEvent, OccurrenceOverride } from "../../model/types";
import { activeOverrides, applyOverride, isOccurrenceOf } from "../../model/occurrences";
import { formatRRule, parseRRule } from "../rrule";
import { ParsedVEvent } from "../ics";
import { RemoteItem, effectiveEnd } from "../remote";
import { addDays } from "../../util/dates";
import { toWallClock, utcToWallClock, wallClockToUtc } from "../../util/timezone";

/**
 * Google Calendar API v3 events <-> the plugin's model. Pure: no requests
 * here, so every case is tested against recorded API shapes.
 *
 * Google stores a repeating event as a master with `recurrence` lines (plain
 * RFC 5545 RRULE/EXDATE text, so the iCloud rule code is reused as-is) plus
 * one record per changed occurrence, linked by `recurringEventId`. An
 * occurrence deleted on a phone is such a record with status "cancelled"
 * rather than an EXDATE; both read as a skipped date.
 */

/** The parts of a Google event this plugin reads or writes. */
export interface GoogleTime {
	date?: string;
	dateTime?: string;
	timeZone?: string;
}

export interface GoogleEvent {
	id: string;
	etag?: string;
	status?: string;
	/** "default" for ordinary events; birthdays, out-of-office and so on are special. */
	eventType?: string;
	summary?: string;
	description?: string;
	location?: string;
	start?: GoogleTime;
	end?: GoogleTime;
	recurrence?: string[];
	recurringEventId?: string;
	originalStartTime?: GoogleTime;
	updated?: string;
	iCalUID?: string;
	extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
}

/** Keys of the plugin's private per-app storage on each event. */
export const PRIVATE = { uid: "tcUid", types: "tcTypes", props: "tcProps" } as const;

/** What the writer needs to find again: the master and its occurrence records. */
export interface GoogleRaw {
	master: GoogleEvent;
	instances: GoogleEvent[];
}

interface Timing {
	date: string;
	allDay: boolean;
	startTime?: string;
	endTime?: string;
}

/** Local date and time for a Google start/end, read in the event's zone. */
function readTime(value: GoogleTime | undefined, timezone: string): { date: string; time?: string } | null {
	if (!value) return null;
	if (value.date) return { date: value.date };
	if (!value.dateTime) return null;
	let instant: number;
	const wall = value.dateTime.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/);
	if (wall) {
		// No offset: a wall-clock time in the zone given alongside it. Date.parse
		// would read it on this computer's clock instead.
		const clock = toWallClock(wall[1], wall[2]);
		if (!clock) return null;
		instant = wallClockToUtc(clock, value.timeZone || timezone);
	} else {
		// RFC 3339 with an offset (what Google returns): already an instant.
		instant = Date.parse(value.dateTime);
	}
	if (isNaN(instant)) return null;
	const local = utcToWallClock(instant, timezone);
	return { date: local.date, time: local.time };
}

function readTiming(event: GoogleEvent, timezone: string): Timing | null {
	const start = readTime(event.start, timezone);
	if (!start) return null;
	if (!start.time) return { date: start.date, allDay: true };
	const end = readTime(event.end, timezone);
	return { date: start.date, allDay: false, startTime: start.time, endTime: end?.time };
}

/** The local date an occurrence record refers to. */
function occurrenceDate(event: GoogleEvent, timezone: string): string | null {
	return readTime(event.originalStartTime, timezone)?.date ?? null;
}

/**
 * Dates named by EXDATE lines. Google echoes back the forms it was given:
 * `EXDATE;VALUE=DATE:20260216`, `EXDATE;TZID=America/Toronto:20260216T100000`
 * or a UTC `EXDATE:20260216T150000Z`, several values comma-separated.
 */
export function readExdates(lines: string[], timezone: string): string[] {
	const dates: string[] = [];
	for (const line of lines) {
		const match = line.match(/^EXDATE([^:]*):(.+)$/i);
		if (!match) continue;
		for (const value of match[2].split(",")) {
			const parts = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
			if (!parts) continue;
			const [, y, m, d, hh, mm, , zulu] = parts;
			if (zulu) {
				const instant = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm));
				dates.push(utcToWallClock(instant, timezone).date);
			} else {
				// A date or a TZID/floating wall-clock time: the date is as written.
				dates.push(`${y}-${m}-${d}`);
			}
		}
	}
	return dates;
}

/** A short version string covering the master and every occurrence record. */
function compositeEtag(master: GoogleEvent, instances: GoogleEvent[]): string {
	const parts = [master.etag ?? "", ...instances.map((i) => `${i.id}:${i.etag ?? ""}:${i.status ?? ""}`).sort()];
	return createHash("sha1").update(parts.join("|")).digest("base64").slice(0, 20);
}

function latest(...stamps: (string | undefined)[]): string | undefined {
	let best: string | undefined;
	for (const stamp of stamps) if (stamp && (!best || Date.parse(stamp) > Date.parse(best))) best = stamp;
	return best ? new Date(Date.parse(best)).toISOString() : undefined;
}

/** True for events this plugin can edit: not birthdays, out-of-office, focus time... */
export function isOrdinary(event: GoogleEvent): boolean {
	return !event.eventType || event.eventType === "default";
}

/**
 * Groups a calendar's events -- masters, one-offs and occurrence records --
 * into normalised items, one per event.
 */
export function readEvents(events: GoogleEvent[], timezone: string): RemoteItem[] {
	const instances = new Map<string, GoogleEvent[]>();
	const masters: GoogleEvent[] = [];
	for (const event of events) {
		if (!isOrdinary(event)) continue;
		if (event.recurringEventId) {
			const list = instances.get(event.recurringEventId) ?? [];
			list.push(event);
			instances.set(event.recurringEventId, list);
		} else if (event.status !== "cancelled") {
			masters.push(event);
		}
	}

	const items: RemoteItem[] = [];
	for (const master of masters) {
		const own = instances.get(master.id) ?? [];
		const parsed = readEvent(master, own, timezone);
		if (!parsed) continue;
		const raw: GoogleRaw = { master, instances: own };
		items.push({ id: master.id, etag: compositeEtag(master, own), event: parsed, raw });
	}
	return items;
}

/** One event, with its occurrence records applied. Null when it cannot be read. */
export function readEvent(master: GoogleEvent, instances: GoogleEvent[], timezone: string): ParsedVEvent | null {
	const timing = readTiming(master, timezone);
	if (!timing) return null;
	const privateProps = master.extendedProperties?.private ?? {};

	const parsed: ParsedVEvent = {
		uid: privateProps[PRIVATE.uid] || master.iCalUID || master.id,
		title: master.summary ?? "Untitled",
		date: timing.date,
		allDay: timing.allDay,
		recurring: false,
		remoteModified: latest(master.updated, ...instances.map((i) => i.updated)),
	};
	if (!timing.allDay) {
		parsed.startTime = timing.startTime;
		if (timing.endTime) parsed.endTime = timing.endTime;
	}
	if (master.location) parsed.location = master.location;
	if (master.description) parsed.description = master.description;

	const types = privateProps[PRIVATE.types];
	if (types) parsed.types = types.split(",").map((t) => t.trim()).filter(Boolean);
	const props = privateProps[PRIVATE.props];
	if (props) {
		try {
			const decoded = JSON.parse(props);
			if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) parsed.props = decoded;
		} catch {
			// A corrupted mirror is not worth failing the pull over.
		}
	}

	const lines = master.recurrence ?? [];
	const rrules = lines.filter((line) => /^RRULE:/i.test(line));
	const other = lines.filter((line) => /^(RDATE|EXRULE)/i.test(line));
	parsed.recurring = rrules.length > 0 || other.length > 0;
	if (rrules.length !== 1 || other.length > 0) return parsed;

	// From here on, anything unreadable leaves `recurrence` unset, which every
	// later stage treats as "the server's; never write it".
	const rule = parseRRule(rrules[0].slice(6), timezone);
	if (!rule) return parsed;
	const series = { uid: parsed.uid, title: "", types: [], allDay: timing.allDay, status: "confirmed" as const,
		props: {}, path: "", date: timing.date, recurrence: rule };

	const exceptions = new Set(readExdates(lines, timezone));
	const overrides: OccurrenceOverride[] = [];
	for (const instance of instances) {
		const occurrence = occurrenceDate(instance, timezone);
		if (!occurrence || !isOccurrenceOf(series, occurrence)) return parsed;
		if (instance.status === "cancelled") {
			exceptions.add(occurrence);
			continue;
		}
		const fields = readTiming(instance, timezone);
		if (!fields) return parsed;
		const override: OccurrenceOverride = { occurrence };
		if (fields.date !== occurrence) override.date = fields.date;
		if (fields.allDay !== timing.allDay) override.allDay = fields.allDay;
		if (!fields.allDay) {
			if (timing.allDay || fields.startTime !== timing.startTime) override.startTime = fields.startTime;
			if (fields.endTime && (timing.allDay || fields.endTime !== timing.endTime)) override.endTime = fields.endTime;
		}
		const differs = (value: string | undefined, series: string | undefined) =>
			value && value.trim() !== (series ?? "").trim();
		if (differs(instance.summary, master.summary)) override.title = instance.summary;
		if (differs(instance.location, master.location)) override.location = instance.location;
		if (differs(instance.description, master.description)) override.description = instance.description;
		// A record that matches the series is what "Reset to series" leaves
		// behind: Google has no way to delete it, only to put it back in line.
		// Reading it as a change would reset it again on every sync. (Unlike
		// iCloud, where a bare override is kept to protect an alarm-only change:
		// here a reset is a patch, which never touches the record's reminders.)
		if (Object.keys(override).length > 1) overrides.push(override);
	}

	parsed.recurrence = rule;
	if (exceptions.size > 0) parsed.exceptions = [...exceptions].sort();
	if (overrides.length > 0) parsed.overrides = overrides.sort((a, b) => a.occurrence.localeCompare(b.occurrence));
	return parsed;
}

// --- writing ------------------------------------------------------------------

/** Start and end in Google's form, for a date and optional times. */
export function timeFields(
	date: string,
	allDay: boolean,
	startTime: string | undefined,
	endTime: string | undefined,
	timezone: string
): { start: GoogleTime; end: GoogleTime } {
	if (allDay || !startTime) {
		// An all-day end is exclusive, as in iCalendar.
		return { start: { date }, end: { date: addDays(date, 1) } };
	}
	const end = effectiveEnd(startTime, endTime);
	// An end at or before the start runs past midnight.
	const endDate = end <= startTime ? addDays(date, 1) : date;
	// Wall-clock time plus a zone, not an instant: Google then repeats a series
	// at the same local hour across a clock change, as iCloud does.
	return {
		start: { dateTime: `${date}T${startTime}:00`, timeZone: timezone },
		end: { dateTime: `${endDate}T${end}:00`, timeZone: timezone },
	};
}

/** The RRULE and EXDATE lines for a series. */
export function recurrenceLines(event: CalendarEvent, timezone: string): string[] | undefined {
	if (!event.recurrence) return undefined;
	const allDay = event.allDay || !event.startTime;
	const lines = [`RRULE:${formatRRule(event.recurrence, timezone, allDay)}`];
	const compact = (date: string) => date.replace(/-/g, "");
	for (const date of [...(event.exceptions ?? [])].sort()) {
		lines.push(
			allDay
				? `EXDATE;VALUE=DATE:${compact(date)}`
				: `EXDATE;TZID=${timezone}:${compact(date)}T${(event.startTime as string).replace(":", "")}00`
		);
	}
	return lines;
}

/** The plugin's private storage: its uid, and the vault-owned types and fields. */
export function privateFields(event: CalendarEvent): Record<string, string> {
	return {
		[PRIVATE.uid]: event.uid,
		[PRIVATE.types]: event.types.join(","),
		[PRIVATE.props]: JSON.stringify(event.props),
	};
}

/**
 * The fields this plugin owns, as a body for insert or patch. Anything not
 * listed -- reminders, attendees, colour, conferencing -- is untouched by a
 * patch, which is what keeps a phone-side alarm alive through an edit.
 */
export function eventBody(event: CalendarEvent, timezone: string): Partial<GoogleEvent> {
	const body: Partial<GoogleEvent> = {
		summary: event.title,
		// An empty string clears a field on patch; leaving it out would keep
		// the old value.
		location: event.location ?? "",
		description: event.description ?? "",
		...timeFields(event.date as string, event.allDay, event.startTime, event.endTime, timezone),
		extendedProperties: { private: privateFields(event) },
	};
	const recurrence = recurrenceLines(event, timezone);
	if (recurrence) body.recurrence = recurrence;
	return body;
}

/** One occurrence as it should look, as a patch for its record. */
export function occurrenceBody(event: CalendarEvent, occurrence: string, override: OccurrenceOverride | undefined, timezone: string): Partial<GoogleEvent> {
	const instance = applyOverride(event, occurrence, override);
	return {
		summary: instance.title,
		location: instance.location ?? "",
		description: instance.description ?? "",
		...timeFields(instance.date, instance.allDay, instance.startTime, instance.endTime, timezone),
	};
}

/**
 * The `originalStart` Google uses to find one occurrence of a series: the
 * date for an all-day series, else the occurrence's start as an instant.
 */
export function originalStart(event: CalendarEvent, occurrence: string, timezone: string): string {
	if (event.allDay || !event.startTime) return occurrence;
	const wall = toWallClock(occurrence, event.startTime);
	if (!wall) return occurrence;
	return new Date(wallClockToUtc(wall, timezone)).toISOString();
}

/** Occurrences this plugin should write, keyed by date. */
export function wantedOverrides(event: CalendarEvent): Map<string, OccurrenceOverride> {
	return new Map(activeOverrides(event).map((o) => [o.occurrence, o]));
}
