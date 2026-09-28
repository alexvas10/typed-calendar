import ICAL from "ical.js";
import { CalendarEvent, OccurrenceOverride } from "../model/types";
import { RecurrenceRule } from "../model/recurrence";
import { Occurrence, activeOverrides, applyOverride, isOccurrenceOf } from "../model/occurrences";
import { isValidTimezone, toWallClock, utcToWallClock, wallClockToUtc } from "../util/timezone";
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
	/**
	 * Occurrences the server holds as separate RECURRENCE-ID components, each
	 * reduced to what differs from the series.
	 */
	overrides?: OccurrenceOverride[];
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
		reconcileOverrides(calendar, vevent, event, timezone, false);
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
 * The value that names one occurrence of a series, for an EXDATE or a
 * RECURRENCE-ID.
 *
 * Built by cloning DTSTART and moving its date, so it keeps the series' value
 * type and TZID. A reference that does not match DTSTART's form is within the
 * server's rights to ignore, and a silently ignored one means a cancelled
 * class quietly reappears or a moved one appears twice.
 */
function occurrenceValue(
	master: ICAL.Component,
	date: string,
	timezone: string
): { time: ICAL.Time; tzid?: string } {
	const dtstart = master.getFirstProperty("dtstart");
	const base = dtstart?.getFirstValue() as ICAL.Time | undefined;
	const tzid = (dtstart?.getParameter("tzid") as string | undefined) ?? undefined;
	// The occurrence's time of day, read in the event's own zone. Taking it
	// from DTSTART rather than from the note keeps the two in step even when
	// the note and the server disagree about the hour.
	const startTime =
		dtstart && base && !base.isDate
			? utcToWallClock(instantOf(dtstart, base, timezone), timezone).time
			: undefined;

	const [year, month, day] = date.split("-").map(Number);
	let time: ICAL.Time;
	if (base && startTime && base.zone?.tzid === "UTC") {
		// DTSTART is a UTC instant, so its calendar date is not necessarily
		// the local one: moving the date on a clone would land the reference
		// a day out. Convert the local occurrence instead.
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
	return { time, tzid: time.isDate ? undefined : tzid };
}

function occurrenceProperty(
	name: string,
	master: ICAL.Component,
	date: string,
	timezone: string
): ICAL.Property {
	const { time, tzid } = occurrenceValue(master, date, timezone);
	const property = new ICAL.Property(name);
	if (time.isDate) property.resetType("date");
	property.setValue(time);
	if (tzid) property.setParameter("tzid", tzid);
	return property;
}

/** Rewrites the EXDATE properties to exactly the given dates. */
function applyExceptions(vevent: ICAL.Component, dates: string[], timezone: string): void {
	vevent.removeAllProperties("exdate");
	for (const date of [...dates].sort()) {
		vevent.addProperty(occurrenceProperty("exdate", vevent, date, timezone));
	}
}

/**
 * The UTC instant a date-time property value names.
 *
 * ical.js resolves a TZID through one process-wide registry in which the
 * first definition registered wins. A definition this plugin wrote only
 * describes the years around the event it came with, so once one is
 * registered, every other time in that zone -- a course from two years ago --
 * is read against it and comes out hours wrong. An IANA TZID is therefore
 * converted here, with Intl's own tz database, and only a zone Intl does not
 * know (an Outlook "Eastern Standard Time") is left to ical.js and the
 * VTIMEZONE the server sent with it.
 *
 * A floating time, with neither TZID nor Z, is wall-clock time in the event's
 * zone, which is how this plugin writes one.
 */
function instantOf(property: ICAL.Property, value: ICAL.Time, timezone: string): number {
	const utc = value.zone?.tzid === "UTC";
	if (!utc) {
		const tzid = property.getParameter("tzid");
		const zone = typeof tzid === "string" ? tzid : tzid ? undefined : timezone;
		if (zone && isValidTimezone(zone)) {
			const wall = { year: value.year, month: value.month, day: value.day, hour: value.hour, minute: value.minute };
			return wallClockToUtc(wall, zone) + value.second * 1000;
		}
	}
	return value.toJSDate().valueOf();
}

/** The local calendar date an EXDATE or RECURRENCE-ID value refers to. */
function localDateOf(property: ICAL.Property, value: ICAL.Time, timezone: string): string {
	return value.isDate
		? value.toString().slice(0, 10)
		: utcToWallClock(instantOf(property, value, timezone), timezone).date;
}

/** Every EXDATE on the component, as local calendar dates. */
function readExceptions(vevent: ICAL.Component, timezone: string): string[] {
	const dates = new Set<string>();
	for (const property of vevent.getAllProperties("exdate")) {
		for (const value of property.getValues() as ICAL.Time[]) {
			if (value) dates.add(localDateOf(property, value, timezone));
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

/** The fields this plugin models, as one VEVENT states them. */
interface ComponentFields {
	date: string;
	allDay: boolean;
	startTime?: string;
	endTime?: string;
	title?: string;
	location?: string;
	description?: string;
}

/** Reads a VEVENT's own fields. Null when it has no usable DTSTART. */
function readFields(vevent: ICAL.Component, timezone: string): ComponentFields | null {
	const startProperty = vevent.getFirstProperty("dtstart");
	const start = startProperty?.getFirstValue() as ICAL.Time | undefined;
	if (!startProperty || !start) return null;

	const fields: ComponentFields = { date: "", allDay: Boolean(start.isDate) };
	if (fields.allDay) {
		fields.date = start.toString().slice(0, 10);
	} else {
		const startLocal = utcToWallClock(instantOf(startProperty, start, timezone), timezone);
		fields.date = startLocal.date;
		fields.startTime = startLocal.time;

		const endProperty = vevent.getFirstProperty("dtend");
		const endValue = endProperty?.getFirstValue() as ICAL.Time | undefined;
		if (endProperty && endValue) {
			fields.endTime = utcToWallClock(instantOf(endProperty, endValue, timezone), timezone).time;
		}
	}

	for (const [key, name] of [
		["title", "summary"],
		["location", "location"],
		["description", "description"],
	] as const) {
		const value = vevent.getFirstPropertyValue(name);
		if (value) fields[key] = String(value);
	}
	return fields;
}

/**
 * Reads a RECURRENCE-ID component as an override: only what differs from the
 * series is kept, so an occurrence moved to another room says just that.
 *
 * An override that changes nothing this plugin models -- only its alarm, say
 * -- still comes back as a bare `{ occurrence }`. Dropping it would make the
 * next push delete the component and the change the user made in Apple
 * Calendar along with it.
 *
 * Null for the forms that cannot be expressed: RANGE=THISANDFUTURE, which
 * rewrites every later occurrence, and a cancelled instance, which Apple
 * never writes and other clients mean as an exclusion.
 */
function readOverride(
	component: ICAL.Component,
	series: ComponentFields,
	timezone: string
): OccurrenceOverride | null {
	const recurrenceId = component.getFirstProperty("recurrence-id");
	if (!recurrenceId || recurrenceId.getParameter("range")) return null;
	if (String(component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") {
		return null;
	}
	const fields = readFields(component, timezone);
	if (!fields) return null;

	const occurrence = localDateOf(recurrenceId, recurrenceId.getFirstValue() as ICAL.Time, timezone);
	const override: OccurrenceOverride = { occurrence };
	if (fields.date !== occurrence) override.date = fields.date;
	if (fields.allDay !== series.allDay) override.allDay = fields.allDay;
	if (!fields.allDay) {
		if (series.allDay || fields.startTime !== series.startTime) {
			override.startTime = fields.startTime;
		}
		if (fields.endTime && (series.allDay || fields.endTime !== series.endTime)) {
			override.endTime = fields.endTime;
		}
	}
	for (const key of ["title", "location", "description"] as const) {
		const value = fields[key];
		if (value && value.trim() !== (series[key] ?? "").trim()) override[key] = value;
	}
	return override;
}

/** A bare event, for asking the recurrence model about a server's series. */
const EMPTY_EVENT: CalendarEvent = {
	uid: "",
	title: "",
	types: [],
	allDay: false,
	status: "confirmed",
	props: {},
	path: "",
};

/**
 * Reads the first VEVENT out of an iCalendar document. Returns null when the
 * body is not parseable, so one malformed resource cannot fail a whole sync.
 */
export function icsToEvent(ics: string, timezone: string): ParsedVEvent | null {
	let vevent: ICAL.Component | null = null;
	let instances: ICAL.Component[] = [];
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
		const master = candidates.find(
			(component) => !component.getFirstPropertyValue("recurrence-id")
		);
		vevent = master ?? candidates[0] ?? null;
		if (master) instances = candidates.filter((component) => component !== master);
	} catch (error) {
		console.warn("Typed Calendar: could not parse iCalendar body", error);
		return null;
	}
	if (!vevent) return null;

	const uid = String(vevent.getFirstPropertyValue("uid") ?? "");
	if (!uid) return null;

	const fields = readFields(vevent, timezone);
	if (!fields) return null;

	const rrule = vevent.getFirstPropertyValue("rrule");
	// RDATE adds dates the rule does not describe, so a rule read on its own
	// would be an incomplete picture of the series.
	const hasRdate = vevent.getAllProperties("rdate").length > 0;
	const manyRules = vevent.getAllProperties("rrule").length > 1;

	const parsed: ParsedVEvent = {
		uid,
		title: fields.title ?? "Untitled",
		allDay: fields.allDay,
		date: fields.date,
		recurring: Boolean(rrule) || hasRdate,
	};
	if (!fields.allDay) {
		parsed.startTime = fields.startTime;
		if (fields.endTime) parsed.endTime = fields.endTime;
	}
	if (fields.location) parsed.location = fields.location;
	if (fields.description) parsed.description = fields.description;

	if (rrule && !hasRdate && !manyRules) {
		const rule = parseRRule(String(rrule), timezone);
		const overrides: OccurrenceOverride[] = [];
		let readable = Boolean(rule);
		for (const instance of rule ? instances : []) {
			if (String(instance.getFirstPropertyValue("uid") ?? "") !== uid) continue;
			const override = readOverride(instance, fields, timezone);
			// An override naming a date this plugin's expansion does not
			// produce means the two disagree about the series itself. Owning
			// it would mean deleting or misplacing that override on the next
			// write, so the whole series stays pull-only instead.
			const known =
				override &&
				rule &&
				isOccurrenceOf(
					{ ...EMPTY_EVENT, uid, date: fields.date, recurrence: rule },
					override.occurrence
				);
			if (!override || !known) {
				readable = false;
				break;
			}
			overrides.push(override);
		}
		// A rule or an override outside the writable subset leaves
		// `recurrence` unset, which is the signal every later stage reads as
		// "pull-only".
		if (rule && readable) {
			parsed.recurrence = rule;
			const exceptions = readExceptions(vevent, timezone);
			if (exceptions.length > 0) parsed.exceptions = exceptions;
			if (overrides.length > 0) {
				parsed.overrides = overrides.sort((a, b) => a.occurrence.localeCompare(b.occurrence));
			}
		}
	}

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

/**
 * Sets a text property only when its value differs, and reports whether it
 * did. Notes store text trimmed, while Apple often keeps a trailing space or
 * newline; comparing them raw would "edit" events nobody touched.
 */
function setText(component: ICAL.Component, name: string, value: string | undefined): boolean {
	const existing = component.getFirstPropertyValue(name);
	const before = existing === null || existing === undefined ? "" : String(existing);
	if (before.trim() === (value ?? "").trim()) return false;
	if (value) component.updatePropertyWithValue(name, value);
	else component.removeProperty(name);
	return true;
}

function touch(component: ICAL.Component): void {
	const stamp = ICAL.Time.fromJSDate(new Date(), true);
	component.updatePropertyWithValue("dtstamp", stamp);
	component.updatePropertyWithValue("last-modified", stamp);
}

/** The event as one occurrence would be written: its own date, no rule. */
function asInstance(event: CalendarEvent, instance: Occurrence): CalendarEvent {
	return {
		...event,
		date: instance.date,
		allDay: instance.allDay,
		startTime: instance.startTime,
		endTime: instance.endTime,
		recurrence: undefined,
	};
}

function sameFields(fields: ComponentFields | null, instance: Occurrence): boolean {
	if (!fields) return false;
	if (fields.date !== instance.date || fields.allDay !== instance.allDay) return false;
	if (instance.allDay) return true;
	return (
		fields.startTime === instance.startTime &&
		(instance.endTime === undefined || fields.endTime === instance.endTime)
	);
}

/**
 * Makes the RECURRENCE-ID components match the event's overrides, and
 * reports whether anything changed.
 *
 * Components are edited in place like the master is, so an alarm or an
 * attendee on one occurrence survives an edit to its room. One the note no
 * longer lists at all -- the user reset it to the series -- is removed. One
 * the note lists but that no longer applies (skipped, or the rule moved off
 * its date) is left exactly as the server has it: removing a server-side
 * change should take a deliberate reset, never a side effect. A new one
 * copies the series' alarms, which is what Apple does when it detaches an
 * occurrence; without them a moved class would silently lose its reminder.
 *
 * `retime` rebuilds every RECURRENCE-ID after the series' start moved: the
 * reference names the original start instant, so one left at the old time
 * would match no occurrence and the change would quietly stop applying.
 */
function reconcileOverrides(
	calendar: ICAL.Component,
	master: ICAL.Component,
	event: CalendarEvent,
	timezone: string,
	retime: boolean
): boolean {
	const wanted = new Map(activeOverrides(event).map((override) => [override.occurrence, override]));
	const listed = new Set((event.overrides ?? []).map((override) => override.occurrence));
	let changed = false;

	for (const component of calendar.getAllSubcomponents("vevent")) {
		const recurrenceId = component.getFirstProperty("recurrence-id");
		if (component === master || !recurrenceId) continue;
		const occurrence = localDateOf(
			recurrenceId,
			recurrenceId.getFirstValue() as ICAL.Time,
			timezone
		);
		const override = wanted.get(occurrence);
		if (!override) {
			if (listed.has(occurrence)) continue;
			calendar.removeSubcomponent(component);
			changed = true;
			continue;
		}
		wanted.delete(occurrence);

		let edited = false;
		if (retime) {
			component.removeAllProperties("recurrence-id");
			component.addProperty(occurrenceProperty("recurrence-id", master, occurrence, timezone));
			edited = true;
		}
		const instance = applyOverride(event, occurrence, override);
		if (!sameFields(readFields(component, timezone), instance)) {
			setTiming(calendar, component, asInstance(event, instance), timezone);
			edited = true;
		}
		if (setText(component, "summary", instance.title)) edited = true;
		if (setText(component, "location", instance.location)) edited = true;
		if (setText(component, "description", instance.description)) edited = true;
		if (edited) {
			touch(component);
			changed = true;
		}
	}

	for (const override of wanted.values()) {
		const instance = applyOverride(event, override.occurrence, override);
		const component = new ICAL.Component("vevent");
		component.updatePropertyWithValue("uid", event.uid);
		component.addProperty(occurrenceProperty("recurrence-id", master, override.occurrence, timezone));
		setTiming(calendar, component, asInstance(event, instance), timezone);
		setText(component, "summary", instance.title);
		setText(component, "location", instance.location);
		setText(component, "description", instance.description);
		for (const alarm of master.getAllSubcomponents("valarm")) {
			const copy = new ICAL.Component(JSON.parse(JSON.stringify(alarm.toJSON())));
			// An alarm's own identifiers must stay unique; the server issues
			// fresh ones for the copy.
			copy.removeAllProperties("uid");
			copy.removeAllProperties("x-wr-alarmuid");
			component.addSubcomponent(copy);
		}
		touch(component);
		calendar.addSubcomponent(component);
		changed = true;
	}
	return changed;
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
 * A series is patched the same way, rule, exclusions and per-occurrence
 * components included -- unless the server's copy repeats in a way the note
 * cannot express, in which case it is returned untouched as pull-only.
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
	// Locked by the user. The planner already skips it; this is the second,
	// independent guard, so no caller can write one by accident.
	if (event.readOnly) {
		return { ics: original, changed: false, recurring: current.recurring, pullOnly: true };
	}
	if (!event.date) return null;

	let calendar: ICAL.Component;
	let vevent: ICAL.Component | undefined;
	try {
		calendar = new ICAL.Component(ICAL.parse(original));
		// The master, not merely the first VEVENT: an override component may
		// come first, and editing it as the series would rewrite one date.
		vevent = calendar
			.getAllSubcomponents("vevent")
			.find((component) => !component.getFirstPropertyValue("recurrence-id"));
	} catch {
		return null;
	}
	if (!vevent) return null;

	let changed = false;
	for (const [name, value] of [
		["summary", event.title],
		["location", event.location],
		["description", event.description],
	] as const) {
		if (setText(vevent, name, value)) changed = true;
	}

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
		if (reconcileOverrides(calendar, vevent, event, timezone, !sameTiming)) changed = true;
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

	touch(vevent);
	return {
		ics: calendar.toString(),
		changed: true,
		recurring: Boolean(event.recurrence),
		pullOnly: false,
	};
}
