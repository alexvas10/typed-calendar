import ICAL from "ical.js";
import { CalendarEvent } from "../model/types";
import { RecurrenceRule } from "../model/recurrence";
import { toWallClock, utcToWallClock, wallClockToUtc } from "../util/timezone";
import { addDays } from "../util/dates";
import { formatRRule, parseRRule, sameRule } from "./rrule";
import { buildVTimezone } from "./vtimezone";

const PROD_ID = "-//Typed Calendar//Obsidian//EN";
const TYPES_PROP = "x-typedcal-types";
const PROPS_PROP = "x-typedcal-props";

/** What a pull can learn about an event from a VEVENT. */
export interface ParsedVEvent {
	uid: string;
	title: string;
	date?: string;
	startTime?: string;
	endTime?: string;
	allDay: boolean;
	location?: string;
	description?: string;
	/** Server-side modification time, used to decide who wins a conflict. */
	remoteModified?: string;
	/** Present only when the event was last written by this plugin. */
	types?: string[];
	props?: Record<string, unknown>;
	/** True when the VEVENT repeats, whether or not we understood how. */
	recurring: boolean;
	/**
	 * The repeat rule, when it fell inside the subset we can also write back.
	 * `recurring` without this is a series we must leave to the server.
	 */
	recurrence?: RecurrenceRule;
	/** Dates excluded from the series (EXDATE), as local dates. */
	exceptions?: string[];
}

/**
 * Undoes RFC 5545 TEXT escaping on the vault-owned X- mirrors.
 *
 * ical.js returns X- properties raw, because it has no type information for
 * them, and iCloud rewrites them as proper escaped TEXT the moment it stores
 * one: `personal,work` comes back as `personal\,work`. Splitting that on a
 * comma produces a type called `personal\`, and JSON.parse of an escaped
 * props mirror throws, so the mirror silently disappears. It also made every
 * comparison in patchICS differ, which would have rewritten any multi-typed
 * event on every single sync.
 */
function unescapeText(value: unknown): string {
	if (value === null || value === undefined) return "";
	return String(value).replace(/\\(.)/g, (_, char: string) =>
		char === "n" || char === "N" ? "\n" : char
	);
}

function addMinutes(time: string, minutes: number): string {
	const [h, m] = time.split(":").map(Number);
	const total = (h * 60 + m + minutes) % 1440;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/**
 * Serialises an event as a complete VCALENDAR ready to PUT.
 *
 * Timed events are written as UTC instants rather than TZID-qualified local
 * times: emitting a TZID without a matching VTIMEZONE is a common source of
 * servers reinterpreting the time, and the vault note keeps the original zone
 * name anyway.
 */
export function eventToICS(event: CalendarEvent, fallbackTimezone: string): string {
	if (!event.date) {
		throw new Error("Cannot serialise an event with no date.");
	}
	const timezone = event.timezone || fallbackTimezone || "UTC";

	const calendar = new ICAL.Component(["vcalendar", [], []]);
	calendar.updatePropertyWithValue("prodid", PROD_ID);
	calendar.updatePropertyWithValue("version", "2.0");

	const vevent = new ICAL.Component("vevent");
	calendar.addSubcomponent(vevent);

	vevent.updatePropertyWithValue("uid", event.uid);
	vevent.updatePropertyWithValue("summary", event.title);

	setTiming(calendar, vevent, event, timezone);

	if (event.location) vevent.updatePropertyWithValue("location", event.location);
	if (event.description) vevent.updatePropertyWithValue("description", event.description);

	if (event.recurrence) {
		const allDay = event.allDay || !event.startTime;
		vevent.updatePropertyWithValue(
			"rrule",
			ICAL.Recur.fromString(formatRRule(event.recurrence, timezone, allDay))
		);
		applyExceptions(vevent, event.exceptions ?? [], timezone);
	}

	// Best-effort mirror of the vault-only data. iCloud may drop unknown X-
	// properties, which is why the vault stays authoritative for both.
	if (event.types.length > 0) {
		vevent.updatePropertyWithValue(TYPES_PROP, event.types.join(","));
	}
	if (Object.keys(event.props).length > 0) {
		vevent.updatePropertyWithValue(PROPS_PROP, JSON.stringify(event.props));
	}

	const stamp = ICAL.Time.fromJSDate(new Date(), true);
	vevent.updatePropertyWithValue("dtstamp", stamp);
	vevent.updatePropertyWithValue("last-modified", stamp);

	return calendar.toString();
}

/**
 * Rewrites the EXDATE properties to exactly the given dates.
 *
 * Each exclusion is built by cloning DTSTART and moving its date, so it keeps
 * the series' value type and TZID. An EXDATE that does not match DTSTART's
 * form is within its rights to be ignored by the server, and a silently
 * ignored exclusion means a cancelled class quietly reappears.
 */
function applyExceptions(vevent: ICAL.Component, dates: string[], timezone: string): void {
	vevent.removeAllProperties("exdate");
	if (dates.length === 0) return;

	const dtstart = vevent.getFirstProperty("dtstart");
	const base = dtstart?.getFirstValue() as ICAL.Time | undefined;
	const tzid = dtstart?.getParameter("tzid");
	// The occurrence's time of day, read in the event's own zone. Taking it
	// from DTSTART rather than from the note keeps the two in step even when
	// the note and the server disagree about the hour.
	const startTime =
		base && !base.isDate
			? utcToWallClock(base.toJSDate().valueOf(), timezone).time
			: undefined;

	for (const date of [...dates].sort()) {
		const [year, month, day] = date.split("-").map(Number);
		let time: ICAL.Time;
		if (base && startTime && base.zone?.tzid === "UTC") {
			// DTSTART is a UTC instant, so its calendar date is not necessarily
			// the local one: moving the date on a clone would land the
			// exclusion a day out. Convert the local occurrence instead.
			const wall = toWallClock(date, startTime);
			time = wall
				? ICAL.Time.fromJSDate(new Date(wallClockToUtc(wall, timezone)), true)
				: base.clone();
		} else if (base) {
			// A TZID-qualified or floating DTSTART already reads as wall-clock
			// time, so moving the date keeps the hour -- and keeps it across a
			// daylight-saving boundary, which an instant would not.
			time = base.clone();
			time.year = year;
			time.month = month;
			time.day = day;
		} else {
			time = ICAL.Time.fromData({ year, month, day, isDate: true });
		}
		const property = new ICAL.Property("exdate");
		if (time.isDate) property.resetType("date");
		property.setValue(time);
		if (tzid && !time.isDate) property.setParameter("tzid", tzid as string);
		vevent.addProperty(property);
	}
}

/** Every EXDATE on the component, as local calendar dates. */
function readExceptions(vevent: ICAL.Component, timezone: string): string[] {
	const dates = new Set<string>();
	for (const property of vevent.getAllProperties("exdate")) {
		for (const value of property.getValues() as ICAL.Time[]) {
			if (!value) continue;
			dates.add(
				value.isDate
					? value.toString().slice(0, 10)
					: utcToWallClock(value.toJSDate().valueOf(), timezone).date
			);
		}
	}
	return Array.from(dates).sort();
}

/**
 * Writes DTSTART/DTEND for an event, replacing whatever was there.
 *
 * A one-off timed event is written as a UTC instant: unambiguous, and an
 * instant cannot be reinterpreted. A *series* cannot be, because a rule over
 * instants repeats every exact 168 hours and so walks an hour sideways at the
 * clock change; it is written against the wall clock, with the VTIMEZONE that
 * makes that wall clock mean something.
 */
function setTiming(
	calendar: ICAL.Component,
	vevent: ICAL.Component,
	event: CalendarEvent,
	timezone: string
): void {
	const date = event.date as string;
	for (const name of ["dtstart", "dtend", "duration"]) vevent.removeAllProperties(name);

	if (event.allDay || !event.startTime) {
		// An all-day DTEND is exclusive, so a single day ends on the next one.
		vevent.addPropertyWithValue("dtstart", dateValue(date));
		vevent.addPropertyWithValue("dtend", dateValue(addDays(date, 1)));
		return;
	}

	const start = event.startTime;
	const endTime = event.endTime ?? addMinutes(start, 60);
	// An end time before the start means the event runs past midnight.
	const endDate = endTime <= start ? addDays(date, 1) : date;

	if (!event.recurrence) {
		vevent.addPropertyWithValue("dtstart", utcValue(date, start, timezone));
		vevent.addPropertyWithValue("dtend", utcValue(endDate, endTime, timezone));
		return;
	}

	const tzid = ensureTimezone(calendar, timezone, Number(date.slice(0, 4)));
	addLocalTime(vevent, "dtstart", date, start, tzid);
	addLocalTime(vevent, "dtend", endDate, endTime, tzid);
}

/**
 * Makes sure the document carries a definition for the zone, and reports the
 * TZID to tag times with. Null means "write floating local time": still
 * correct across a clock change, and honest about knowing no more than that.
 */
function ensureTimezone(calendar: ICAL.Component, timezone: string, year: number): string | null {
	if (!timezone || timezone === "UTC") return null;
	for (const existing of calendar.getAllSubcomponents("vtimezone")) {
		if (String(existing.getFirstPropertyValue("tzid")) === timezone) return timezone;
	}
	const vtimezone = buildVTimezone(timezone, year);
	if (!vtimezone) return null;
	// Apple expects the definition before the event that references it.
	calendar.addSubcomponent(vtimezone);
	return timezone;
}

function addLocalTime(
	vevent: ICAL.Component,
	name: string,
	date: string,
	time: string,
	tzid: string | null
): void {
	const wall = toWallClock(date, time);
	if (!wall) throw new Error(`Invalid date/time: ${date} ${time}`);
	const property = new ICAL.Property(name);
	property.setValue(
		ICAL.Time.fromData({
			year: wall.year,
			month: wall.month,
			day: wall.day,
			hour: wall.hour,
			minute: wall.minute,
			second: 0,
		})
	);
	if (tzid) property.setParameter("tzid", tzid);
	vevent.addProperty(property);
}

function dateValue(date: string): ICAL.Time {
	const [year, month, day] = date.split("-").map(Number);
	return ICAL.Time.fromData({ year, month, day, isDate: true });
}

function utcValue(date: string, time: string, timezone: string): ICAL.Time {
	const wall = toWallClock(date, time);
	if (!wall) throw new Error(`Invalid date/time: ${date} ${time}`);
	return ICAL.Time.fromJSDate(new Date(wallClockToUtc(wall, timezone)), true);
}

/**
 * Reads the first VEVENT out of an iCalendar document. Returns null when the
 * body is not parseable, so one malformed resource cannot fail a whole sync.
 */
export function icsToEvent(ics: string, timezone: string): ParsedVEvent | null {
	let vevent: ICAL.Component | null = null;
	// Per-occurrence overrides ("this Tuesday only, in a different room") are
	// something the plugin can display but not express, so their presence
	// alone makes the series one we refuse to write.
	let hasOverrides = false;
	try {
		const calendar = new ICAL.Component(ICAL.parse(ics));
		// Without this a TZID-qualified time resolves as floating and is read
		// on whatever clock this machine happens to keep.
		for (const definition of calendar.getAllSubcomponents("vtimezone")) {
			const zone = new ICAL.Timezone(definition);
			if (zone.tzid && !ICAL.TimezoneService.has(zone.tzid)) {
				ICAL.TimezoneService.register(zone);
			}
		}

		// Recurrence overrides share a UID with their series; the master is the
		// one without a RECURRENCE-ID.
		const candidates = calendar.getAllSubcomponents("vevent");
		hasOverrides = candidates.some((component) =>
			Boolean(component.getFirstPropertyValue("recurrence-id"))
		);
		vevent =
			candidates.find((component) => !component.getFirstPropertyValue("recurrence-id")) ??
			candidates[0] ??
			null;
	} catch (error) {
		console.warn("Typed Calendar: could not parse iCalendar body", error);
		return null;
	}
	if (!vevent) return null;

	const uid = String(vevent.getFirstPropertyValue("uid") ?? "");
	if (!uid) return null;

	const dtstart = vevent.getFirstProperty("dtstart");
	if (!dtstart) return null;
	const start = dtstart.getFirstValue() as ICAL.Time;
	const allDay = Boolean(start.isDate);

	const rrule = vevent.getFirstPropertyValue("rrule");
	// RDATE adds dates the rule does not describe, so a rule read on its own
	// would be an incomplete picture of the series.
	const hasRdate = vevent.getAllProperties("rdate").length > 0;
	const manyRules = vevent.getAllProperties("rrule").length > 1;

	const parsed: ParsedVEvent = {
		uid,
		title: String(vevent.getFirstPropertyValue("summary") ?? "Untitled"),
		allDay,
		recurring: Boolean(rrule) || hasRdate,
	};

	if (rrule && !hasRdate && !manyRules && !hasOverrides) {
		const rule = parseRRule(String(rrule), timezone);
		// A rule outside the writable subset leaves `recurrence` unset, which
		// is the signal every later stage reads as "pull-only".
		if (rule) {
			parsed.recurrence = rule;
			const exceptions = readExceptions(vevent, timezone);
			if (exceptions.length > 0) parsed.exceptions = exceptions;
		}
	}

	if (allDay) {
		parsed.date = start.toString().slice(0, 10);
	} else {
		const startLocal = utcToWallClock(start.toJSDate().valueOf(), timezone);
		parsed.date = startLocal.date;
		parsed.startTime = startLocal.time;

		const endValue = vevent.getFirstProperty("dtend")?.getFirstValue() as ICAL.Time | undefined;
		if (endValue) {
			parsed.endTime = utcToWallClock(endValue.toJSDate().valueOf(), timezone).time;
		}
	}

	const location = vevent.getFirstPropertyValue("location");
	if (location) parsed.location = String(location);
	const description = vevent.getFirstPropertyValue("description");
	if (description) parsed.description = String(description);

	const lastModified = vevent.getFirstProperty("last-modified")?.getFirstValue() as
		| ICAL.Time
		| undefined;
	if (lastModified) parsed.remoteModified = lastModified.toJSDate().toISOString();

	const types = vevent.getFirstPropertyValue(TYPES_PROP);
	if (types) {
		parsed.types = unescapeText(types)
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean);
	}
	const props = vevent.getFirstPropertyValue(PROPS_PROP);
	if (props) {
		try {
			const decoded = JSON.parse(unescapeText(props));
			if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
				parsed.props = decoded as Record<string, unknown>;
			}
		} catch {
			// A corrupted mirror is not worth failing the pull over.
		}
	}

	return parsed;
}

export interface PatchResult {
	ics: string;
	/** False when the server copy already matches, so no write is needed. */
	changed: boolean;
	/** True when the event repeats. */
	recurring: boolean;
	/**
	 * The server copy is a series the plugin must not author. Callers must
	 * treat this as "never write this resource", not merely "no change".
	 */
	pullOnly: boolean;
}

/**
 * Applies an event's edits onto the server's existing iCalendar body.
 *
 * Regenerating a VEVENT from the note (eventToICS) is only safe for a brand
 * new event. For an existing one it silently discards everything the plugin
 * does not model -- alarms, recurrence rules, attendees, URLs, notes, TZID,
 * X-APPLE-* -- and did exactly that to a real calendar. Here the original
 * component is edited in place, and a property is touched only if its value
 * actually differs, so an edit to the title leaves every alarm intact and a
 * no-op yields changed=false and no write at all.
 *
 * Recurring events are returned untouched. The note holds one occurrence, so
 * pushing it back would flatten the series; they are pull-only.
 *
 * Returns null when the body cannot be parsed. Callers must refuse to write
 * rather than fall back to eventToICS.
 */
export function patchICS(
	original: string,
	event: CalendarEvent,
	fallbackTimezone: string
): PatchResult | null {
	const timezone = event.timezone || fallbackTimezone || "UTC";
	const current = icsToEvent(original, timezone);
	if (!current) return null;
	// The server repeats this event in a way we could not read back as a rule.
	// Editing it would flatten the series, so it is reported untouched and the
	// planner keeps it pull-only.
	if (current.recurring && !current.recurrence) {
		return { ics: original, changed: false, recurring: true, pullOnly: true };
	}
	// The server repeats, the note does not say so. That is either a genuine
	// "stop repeating" or a note written before the plugin could read rules,
	// and the two are indistinguishable here. Stripping an RRULE on a guess is
	// how a weekly class becomes a single orphaned event, so neither is
	// written: removing a repeat means deleting the event and making it again.
	if (current.recurrence && !event.recurrence) {
		return { ics: original, changed: false, recurring: true, pullOnly: true };
	}
	if (!event.date) return null;

	let calendar: ICAL.Component;
	let vevent: ICAL.Component | undefined;
	try {
		calendar = new ICAL.Component(ICAL.parse(original));
		vevent = calendar.getAllSubcomponents("vevent")[0];
	} catch {
		return null;
	}
	if (!vevent) return null;

	let changed = false;
	const setText = (name: string, value: string | undefined) => {
		const existing = vevent!.getFirstPropertyValue(name);
		const before = existing === null || existing === undefined ? "" : String(existing);
		// Notes store text trimmed, while Apple often keeps a trailing space or
		// newline. Comparing them raw would "edit" events nobody touched.
		if (before.trim() === (value ?? "").trim()) return;
		changed = true;
		if (value) vevent!.updatePropertyWithValue(name, value);
		else vevent!.removeProperty(name);
	};

	setText("summary", event.title);
	setText("location", event.location);
	setText("description", event.description);

	const timed = !event.allDay && Boolean(event.startTime);
	const sameTiming =
		current.date === event.date &&
		current.allDay === !timed &&
		(!timed ||
			(current.startTime === event.startTime &&
				(event.endTime === undefined || current.endTime === event.endTime)));

	if (!sameTiming) {
		changed = true;
		// The properties are replaced rather than updated: a leftover TZID
		// parameter would contradict a UTC value, and vice versa.
		setTiming(calendar, vevent, { ...event, allDay: !timed }, timezone);
	}

	const allDay = !timed;
	if (!sameRule(current.recurrence, event.recurrence, timezone, allDay)) {
		changed = true;
		// Only ever writes a rule, never removes one: the no-rule case returned
		// above.
		vevent.updatePropertyWithValue(
			"rrule",
			ICAL.Recur.fromString(formatRRule(event.recurrence as RecurrenceRule, timezone, allDay))
		);
	}

	if (event.recurrence) {
		const wanted = [...(event.exceptions ?? [])].sort();
		const differ = wanted.join(",") !== (current.exceptions ?? []).join(",");
		if (differ) changed = true;
		// Exclusions are cloned from DTSTART, so a timing change means
		// rebuilding them even when the set itself is the same: a stale one
		// lines up with no occurrence and silently excludes nothing.
		if (differ || !sameTiming) applyExceptions(vevent, wanted, timezone);
	}

	// The X- mirror is best effort and additive: only ever written when the
	// event has something to mirror and it differs from what is there. The
	// server's copy is compared unescaped, or an escaped comma would read as a
	// difference and rewrite the event on every sync forever.
	const setMirror = (name: string, value: string) => {
		if (unescapeText(vevent!.getFirstPropertyValue(name)).trim() === value.trim()) return;
		changed = true;
		vevent!.updatePropertyWithValue(name, value);
	};
	if (event.types.length > 0) setMirror(TYPES_PROP, event.types.join(","));
	if (Object.keys(event.props).length > 0) setMirror(PROPS_PROP, JSON.stringify(event.props));

	if (!changed) {
		return { ics: original, changed: false, recurring: Boolean(event.recurrence), pullOnly: false };
	}

	const stamp = ICAL.Time.fromJSDate(new Date(), true);
	vevent.updatePropertyWithValue("dtstamp", stamp);
	vevent.updatePropertyWithValue("last-modified", stamp);
	return {
		ics: calendar.toString(),
		changed: true,
		recurring: Boolean(event.recurrence),
		pullOnly: false,
	};
}
