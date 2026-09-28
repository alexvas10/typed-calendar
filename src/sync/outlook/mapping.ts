import { createHash } from "node:crypto";
import { CalendarEvent, OccurrenceOverride } from "../../model/types";
import {
	NthWeekday,
	RecurrenceRule,
	WEEKDAYS,
	Weekday,
	canonicalRule,
	expandOccurrences,
	isPositional,
} from "../../model/recurrence";
import { applyOverride, isOccurrenceOf } from "../../model/occurrences";
import { ParsedVEvent } from "../ics";
import { RemoteItem, effectiveEnd } from "../remote";
import { addDays } from "../../util/dates";

/**
 * Microsoft Graph (Outlook) events <-> the plugin's model. Pure, so every
 * case is tested against recorded API shapes.
 *
 * Graph describes repetition as a structured `patternedRecurrence` rather
 * than RRULE text, so this module translates both ways and refuses the rules
 * Outlook cannot express. Times are requested in the user's own zone
 * (`Prefer: outlook.timezone`), so a start comes back as a wall-clock
 * reading in that zone and needs no conversion.
 */

export interface GraphTime {
	/** "2026-02-04T10:00:00.0000000" -- wall clock, no offset. */
	dateTime: string;
	timeZone: string;
}

export interface GraphPattern {
	type: "daily" | "weekly" | "absoluteMonthly" | "relativeMonthly" | "absoluteYearly" | "relativeYearly";
	interval: number;
	daysOfWeek?: string[];
	dayOfMonth?: number;
	month?: number;
	index?: "first" | "second" | "third" | "fourth" | "last";
	firstDayOfWeek?: string;
}

export interface GraphRange {
	type: "endDate" | "noEnd" | "numbered";
	startDate: string;
	endDate?: string;
	numberOfOccurrences?: number;
	recurrenceTimeZone?: string;
}

export interface GraphEvent {
	id: string;
	changeKey?: string;
	type?: "singleInstance" | "occurrence" | "exception" | "seriesMaster";
	subject?: string;
	body?: { contentType?: string; content?: string };
	location?: { displayName?: string };
	start?: GraphTime;
	end?: GraphTime;
	isAllDay?: boolean;
	isCancelled?: boolean;
	recurrence?: { pattern: GraphPattern; range: GraphRange } | null;
	originalStart?: string;
	seriesMasterId?: string;
	lastModifiedDateTime?: string;
	iCalUId?: string;
	singleValueExtendedProperties?: { id: string; value: string }[];
}

/**
 * The plugin's private properties on an Outlook event. Extended properties
 * are named inside a namespace GUID; this one is fixed for the plugin.
 */
const NAMESPACE = "{3f6c0a92-7b1e-4d5a-9c1e-5b7a2d4e8f10}";
export const PROPERTY = {
	uid: `String ${NAMESPACE} Name tcUid`,
	types: `String ${NAMESPACE} Name tcTypes`,
	props: `String ${NAMESPACE} Name tcProps`,
} as const;

/** The $expand that returns the plugin's properties with each event. */
export const EXPAND_PROPERTIES = `singleValueExtendedProperties($filter=${Object.values(PROPERTY)
	.map((id) => `id eq '${id}'`)
	.join(" or ")})`;

const DAY_NAMES: Record<Weekday, string> = {
	SU: "sunday", MO: "monday", TU: "tuesday", WE: "wednesday", TH: "thursday", FR: "friday", SA: "saturday",
};
const DAY_CODES = Object.fromEntries(Object.entries(DAY_NAMES).map(([code, name]) => [name, code])) as Record<string, Weekday>;
const INDEXES = ["first", "second", "third", "fourth"] as const;

function toIndex(nth: number): GraphPattern["index"] | null {
	if (nth === -1) return "last";
	return nth >= 1 && nth <= 4 ? INDEXES[nth - 1] : null;
}

function fromIndex(index: GraphPattern["index"]): number {
	return index === "last" ? -1 : INDEXES.indexOf(index as (typeof INDEXES)[number]) + 1;
}

// --- rules ----------------------------------------------------------------------

/**
 * Why a rule has no Outlook pattern, or null when it has one. Outlook offers
 * one day of the month, one weekday position (first to fourth, or last), and
 * one month a year -- which covers what people actually set, but not "the
 * 1st and 15th" or "the fifth Friday".
 */
export function outlookRuleProblem(rule: RecurrenceRule): string | null {
	if (rule.freq === "daily" || rule.freq === "weekly") return null;
	if ((rule.byMonth?.length ?? 0) > 1) return "Outlook repeats yearly in one month only";
	if (rule.byMonthDay) {
		if (rule.byMonthDay.length > 1) return "Outlook repeats on one day of the month only";
		if (rule.byMonthDay[0] < 1) return "Outlook cannot count days from the end of the month";
		if (rule.byDay?.length || rule.byNthDay?.length || rule.bySetPos?.length) {
			return "Outlook cannot combine a day of the month with a weekday";
		}
		return null;
	}
	if (rule.byNthDay) {
		if (rule.byNthDay.length > 1) return "Outlook repeats on one weekday position only";
		if (!toIndex(rule.byNthDay[0].nth)) return "Outlook counts weekdays first to fourth, or last";
		if (rule.byDay?.length || rule.bySetPos?.length) return "Outlook cannot mix weekday positions";
		return null;
	}
	if (rule.byDay?.length) {
		// Plain weekdays in a month only make sense narrowed by one position:
		// "the last weekday" is MO-FR at -1.
		if (rule.bySetPos?.length !== 1 || !toIndex(rule.bySetPos[0])) {
			return "Outlook needs one position for weekdays in a month";
		}
		return null;
	}
	if (rule.bySetPos?.length) return "Outlook cannot pick a position without weekdays";
	return null;
}

/** Our rule as an Outlook pattern and range. Call outlookRuleProblem first. */
export function toPattern(
	rule: RecurrenceRule,
	start: string,
	timezone: string
): { pattern: GraphPattern; range: GraphRange } {
	const [, startMonth, startDay] = start.split("-").map(Number);
	const pattern: GraphPattern = { type: "daily", interval: rule.interval };
	if (rule.freq === "weekly") {
		pattern.type = "weekly";
		const days = rule.byDay?.length ? rule.byDay : [WEEKDAYS[new Date(`${start}T12:00:00Z`).getUTCDay()]];
		pattern.daysOfWeek = days.map((day) => DAY_NAMES[day]);
		// Expansion anchors weeks on Sunday; say so, so an every-other-week
		// rule skips the same weeks on both sides.
		pattern.firstDayOfWeek = "sunday";
	} else if (rule.freq === "monthly" || rule.freq === "yearly") {
		const yearly = rule.freq === "yearly";
		if (yearly) pattern.month = rule.byMonth?.[0] ?? startMonth;
		const nth = rule.byNthDay?.[0];
		if (nth) {
			pattern.type = yearly ? "relativeYearly" : "relativeMonthly";
			pattern.daysOfWeek = [DAY_NAMES[nth.day]];
			pattern.index = toIndex(nth.nth) ?? "first";
		} else if (rule.byDay?.length) {
			pattern.type = yearly ? "relativeYearly" : "relativeMonthly";
			pattern.daysOfWeek = rule.byDay.map((day) => DAY_NAMES[day]);
			pattern.index = toIndex(rule.bySetPos?.[0] ?? 1) ?? "first";
		} else {
			pattern.type = yearly ? "absoluteYearly" : "absoluteMonthly";
			pattern.dayOfMonth = rule.byMonthDay?.[0] ?? startDay;
		}
	}

	const range: GraphRange = { type: "noEnd", startDate: start, recurrenceTimeZone: timezone };
	if (rule.until) {
		range.type = "endDate";
		range.endDate = rule.until;
	} else if (rule.count) {
		range.type = "numbered";
		range.numberOfOccurrences = rule.count;
	}
	return { pattern, range };
}

/**
 * An Outlook pattern as our rule, or null when it cannot be represented.
 * A day that merely repeats the start date's is dropped, so a plain monthly
 * rule reads back exactly as written rather than as "on day 4" and looking
 * changed forever.
 */
export function fromPattern(pattern: GraphPattern, range: GraphRange, start: string): RecurrenceRule | null {
	const interval = Math.max(1, pattern.interval || 1);
	const [, startMonth, startDay] = start.split("-").map(Number);
	const days = (pattern.daysOfWeek ?? []).map((name) => DAY_CODES[name.toLowerCase()]);
	if (days.some((day) => !day)) return null;

	let rule: RecurrenceRule;
	switch (pattern.type) {
		case "daily":
			rule = { freq: "daily", interval };
			break;
		case "weekly":
			if (interval > 1 && (pattern.firstDayOfWeek ?? "sunday").toLowerCase() !== "sunday") return null;
			rule = { freq: "weekly", interval, byDay: days.length ? days : undefined };
			break;
		case "absoluteMonthly":
		case "absoluteYearly": {
			const yearly = pattern.type === "absoluteYearly";
			rule = { freq: yearly ? "yearly" : "monthly", interval };
			const day = pattern.dayOfMonth ?? startDay;
			const month = pattern.month ?? startMonth;
			if (day !== startDay || (yearly && month !== startMonth)) {
				rule.byMonthDay = [day];
				if (yearly) rule.byMonth = [month];
			}
			break;
		}
		case "relativeMonthly":
		case "relativeYearly": {
			if (days.length === 0 || !pattern.index) return null;
			const yearly = pattern.type === "relativeYearly";
			rule = { freq: yearly ? "yearly" : "monthly", interval };
			if (yearly) rule.byMonth = [pattern.month ?? startMonth];
			const nth = fromIndex(pattern.index);
			if (days.length === 1) rule.byNthDay = [{ nth, day: days[0] } as NthWeekday];
			else {
				rule.byDay = days;
				rule.bySetPos = [nth];
			}
			break;
		}
		default:
			return null;
	}
	if (range.type === "endDate" && range.endDate) rule.until = range.endDate.slice(0, 10);
	else if (range.type === "numbered" && range.numberOfOccurrences) rule.count = range.numberOfOccurrences;
	return canonicalRule(rule);
}

// --- reading --------------------------------------------------------------------

/** "2026-02-04T10:00:00.0000000" -> date and "10:00". */
function wall(value: GraphTime | undefined): { date: string; time: string } | null {
	const match = value?.dateTime?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
	return match ? { date: match[1], time: match[2] } : null;
}

function property(event: GraphEvent, id: string): string | undefined {
	return event.singleValueExtendedProperties?.find((p) => p.id.toLowerCase() === id.toLowerCase())?.value;
}

function text(value: string | undefined): string | undefined {
	const trimmed = (value ?? "").trim();
	return trimmed || undefined;
}

interface Fields {
	date: string;
	allDay: boolean;
	startTime?: string;
	endTime?: string;
	title?: string;
	location?: string;
	description?: string;
}

function readFields(event: GraphEvent): Fields | null {
	const start = wall(event.start);
	if (!start) return null;
	const fields: Fields = {
		date: start.date,
		allDay: Boolean(event.isAllDay),
		title: event.subject,
		location: text(event.location?.displayName),
		description: text(event.body?.content),
	};
	if (!fields.allDay) {
		fields.startTime = start.time;
		const end = wall(event.end);
		if (end) fields.endTime = end.time;
	}
	return fields;
}

/**
 * A series' version: its own changeKey plus those of its changed occurrences
 * and the dates it skips, so a phone-side edit to one week is noticed.
 */
function compositeEtag(master: GraphEvent, instances: GraphEvent[], skipped: string[]): string {
	const parts = [
		master.changeKey ?? "",
		...instances.filter((i) => i.type === "exception").map((i) => `${i.id}:${i.changeKey ?? ""}`).sort(),
		...skipped,
	];
	return createHash("sha1").update(parts.join("|")).digest("base64").slice(0, 20);
}

/**
 * One Outlook event, normalised. `instances` are a series' occurrences over
 * the window the caller fetched; Graph lists occurrences rather than
 * exceptions, so a skipped date is one the rule produces that is missing.
 */
export function readEvent(event: GraphEvent, instances: GraphEvent[], window: { from: string; to: string }): RemoteItem | null {
	const fields = readFields(event);
	if (!fields) return null;
	const parsed: ParsedVEvent = {
		uid: property(event, PROPERTY.uid) || event.iCalUId || event.id,
		title: fields.title ?? "Untitled",
		date: fields.date,
		allDay: fields.allDay,
		recurring: event.type === "seriesMaster",
		remoteModified: event.lastModifiedDateTime ? new Date(event.lastModifiedDateTime).toISOString() : undefined,
	};
	if (!fields.allDay) {
		parsed.startTime = fields.startTime;
		if (fields.endTime) parsed.endTime = fields.endTime;
	}
	if (fields.location) parsed.location = fields.location;
	if (fields.description) parsed.description = fields.description;
	const types = property(event, PROPERTY.types);
	if (types) parsed.types = types.split(",").map((t) => t.trim()).filter(Boolean);
	const props = property(event, PROPERTY.props);
	if (props) {
		try {
			const decoded = JSON.parse(props);
			if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) parsed.props = decoded;
		} catch {
			// A corrupted mirror is not worth failing the pull over.
		}
	}

	if (event.type !== "seriesMaster" || !event.recurrence) {
		return { id: event.id, etag: event.changeKey ?? "", event: parsed, raw: { master: event, instances: [] } };
	}

	// From here, anything unreadable leaves `recurrence` unset: pull-only.
	const pull = { id: event.id, etag: compositeEtag(event, instances, []), event: parsed, raw: { master: event, instances } };
	const rule = fromPattern(event.recurrence.pattern, event.recurrence.range, fields.date);
	if (!rule) return pull;
	const series = { uid: parsed.uid, title: "", types: [], allDay: fields.allDay, status: "confirmed" as const,
		props: {}, path: "", date: fields.date, recurrence: rule };

	const present = new Set<string>();
	const overrides: OccurrenceOverride[] = [];
	for (const instance of instances) {
		const originalDate = instance.originalStart?.slice(0, 10) ?? wall(instance.start)?.date;
		if (!originalDate) continue;
		present.add(originalDate);
		if (instance.type !== "exception") continue;
		if (!isOccurrenceOf(series, originalDate)) return pull;
		const own = readFields(instance);
		if (!own) return pull;
		const override: OccurrenceOverride = { occurrence: originalDate };
		if (own.date !== originalDate) override.date = own.date;
		if (own.allDay !== fields.allDay) override.allDay = own.allDay;
		if (!own.allDay) {
			if (fields.allDay || own.startTime !== fields.startTime) override.startTime = own.startTime;
			if (own.endTime && (fields.allDay || own.endTime !== fields.endTime)) override.endTime = own.endTime;
		}
		const differs = (value: string | undefined, base: string | undefined) => value && value !== (base ?? "");
		if (differs(text(own.title), text(fields.title))) override.title = own.title;
		if (differs(own.location, fields.location)) override.location = own.location;
		if (differs(own.description, fields.description)) override.description = own.description;
		// An exception that matches the series is what a reset leaves behind;
		// see the Google reader for why it is not a change.
		if (Object.keys(override).length > 1) overrides.push(override);
	}

	// Graph lists occurrences, not deletions: a date the rule produces in the
	// window that did not come back was deleted.
	const expected = expandOccurrences(fields.date, rule, [], window);
	const skipped = expected.filter((date) => !present.has(date));

	parsed.recurrence = rule;
	if (skipped.length > 0) parsed.exceptions = skipped;
	if (overrides.length > 0) parsed.overrides = overrides.sort((a, b) => a.occurrence.localeCompare(b.occurrence));
	return { id: event.id, etag: compositeEtag(event, instances, skipped), event: parsed, raw: { master: event, instances } };
}

/**
 * The span to list a series' occurrences over: from its first date to its
 * end, capped two years out so an endless series stays one request.
 */
export function occurrenceWindow(start: string, rule: RecurrenceRule | undefined, today: string): { from: string; to: string } {
	const cap = addDays(today, 730);
	let to = cap;
	if (rule?.until && rule.until < cap) to = rule.until;
	else if (rule?.count) {
		const dates = expandOccurrences(start, rule, [], { from: start, to: cap });
		if (dates.length > 0) to = dates[dates.length - 1];
	}
	return { from: start, to: to < start ? start : to };
}

// --- writing --------------------------------------------------------------------

export function timeFields(
	date: string,
	allDay: boolean,
	startTime: string | undefined,
	endTime: string | undefined,
	timezone: string
): { start: GraphTime; end: GraphTime; isAllDay: boolean } {
	if (allDay || !startTime) {
		return {
			isAllDay: true,
			start: { dateTime: `${date}T00:00:00`, timeZone: timezone },
			end: { dateTime: `${addDays(date, 1)}T00:00:00`, timeZone: timezone },
		};
	}
	const end = effectiveEnd(startTime, endTime);
	const endDate = end <= startTime ? addDays(date, 1) : date;
	return {
		isAllDay: false,
		start: { dateTime: `${date}T${startTime}:00`, timeZone: timezone },
		end: { dateTime: `${endDate}T${end}:00`, timeZone: timezone },
	};
}

/** The plugin's private properties: its uid, and the vault-owned types and fields. */
export function extendedProperties(event: CalendarEvent): { id: string; value: string }[] {
	return [
		{ id: PROPERTY.uid, value: event.uid },
		{ id: PROPERTY.types, value: event.types.join(",") },
		{ id: PROPERTY.props, value: JSON.stringify(event.props) },
	];
}

/** The fields this plugin owns, as a body for create or patch. */
export function eventBody(event: CalendarEvent, timezone: string): Record<string, unknown> {
	const body: Record<string, unknown> = {
		subject: event.title,
		body: { contentType: "text", content: event.description ?? "" },
		location: { displayName: event.location ?? "" },
		...timeFields(event.date as string, event.allDay, event.startTime, event.endTime, timezone),
		singleValueExtendedProperties: extendedProperties(event),
	};
	if (event.recurrence) body.recurrence = toPattern(event.recurrence, event.date as string, timezone);
	return body;
}

/** One occurrence as it should look, as a patch for its instance. */
export function occurrenceBody(event: CalendarEvent, occurrence: string, override: OccurrenceOverride | undefined, timezone: string): Record<string, unknown> {
	const instance = applyOverride(event, occurrence, override);
	return {
		subject: instance.title,
		body: { contentType: "text", content: instance.description ?? "" },
		location: { displayName: instance.location ?? "" },
		...timeFields(instance.date, instance.allDay, instance.startTime, instance.endTime, timezone),
	};
}

/** True when a rule uses parts Outlook can hold -- for callers outside this module. */
export function fitsOutlook(rule: RecurrenceRule | undefined): boolean {
	return !rule || !isPositional(rule) || outlookRuleProblem(rule) === null;
}
