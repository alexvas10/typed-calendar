import { CalendarEvent, EventType } from "./types";
import { expandEvent } from "./occurrences";
import { addDays, daysUntil, startOfToday, toDateString } from "../util/dates";

export interface PriorityRow {
	event: CalendarEvent;
	/**
	 * The date this row is about. For a repeating event it is one occurrence,
	 * not the series start, so a weekly class shows up on each of its days.
	 * A moved occurrence is listed on the date it moved to.
	 */
	date: string;
	/** The date the rule gave this occurrence, which is what skipping acts on. */
	occurrence: string;
	/** The occurrence's own title, when it was renamed on its own. */
	title: string;
	days: number;
	/** Type-declared fields marked showInPriority, already formatted. */
	annotations: string[];
}

/** Highest rank among an event's types; untyped events sort last. */
function rankOf(event: CalendarEvent, types: Map<string, EventType>): number {
	let best = Number.NEGATIVE_INFINITY;
	for (const id of event.types) {
		const type = types.get(id);
		if (type && type.rank > best) best = type.rank;
	}
	return best === Number.NEGATIVE_INFINITY ? 0 : best;
}

/**
 * Largest numeric value across the event's showInPriority fields. Used only to
 * break ties, so a 45% exam outranks a 5% quiz on the same day.
 */
function weightOf(event: CalendarEvent, types: Map<string, EventType>): number {
	let best = 0;
	for (const id of event.types) {
		for (const field of types.get(id)?.fields ?? []) {
			if (!field.showInPriority || field.type !== "number") continue;
			const value = Number(event.props[field.key]);
			if (!isNaN(value) && value > best) best = value;
		}
	}
	return best;
}

export function annotationsFor(
	event: CalendarEvent,
	types: Map<string, EventType>
): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const id of event.types) {
		for (const field of types.get(id)?.fields ?? []) {
			if (!field.showInPriority || seen.has(field.key)) continue;
			const value = event.props[field.key];
			if (value === undefined || value === null || value === "") continue;
			seen.add(field.key);
			out.push(`${value}${field.unit ?? ""}`);
		}
	}
	if (event.location) out.push(event.location);
	return out;
}

export function indexTypes(types: EventType[]): Map<string, EventType> {
	return new Map(types.map((type) => [type.id, type]));
}

/**
 * Orders scheduled events by urgency: soonest first, then by type rank, then
 * by the heaviest numeric field. The rule is deliberately a plain sort rather
 * than a blended score so a surprising ordering is always explainable.
 */
export function buildPriorityRows(
	events: CalendarEvent[],
	types: EventType[],
	horizonDays: number
): PriorityRow[] {
	const typeMap = indexTypes(types);
	const today = startOfToday();

	const from = toDateString(today);
	const to = addDays(from, horizonDays);

	const rows: PriorityRow[] = [];
	for (const event of events) {
		if (!event.date) continue;
		// A repeating event contributes every occurrence inside the horizon;
		// a single one contributes itself, or nothing when it falls outside.
		for (const instance of expandEvent(event, { from, to })) {
			const days = daysUntil(instance.date, today);
			if (days === null) continue;
			rows.push({
				event,
				date: instance.date,
				occurrence: instance.occurrence,
				title: instance.title,
				days,
				// A room change on one occurrence is exactly what this list is
				// for noticing, so the annotations follow the occurrence.
				annotations: annotationsFor({ ...event, location: instance.location }, typeMap),
			});
		}
	}

	rows.sort((a, b) => {
		if (a.days !== b.days) return a.days - b.days;
		const rankDelta = rankOf(b.event, typeMap) - rankOf(a.event, typeMap);
		if (rankDelta !== 0) return rankDelta;
		const weightDelta = weightOf(b.event, typeMap) - weightOf(a.event, typeMap);
		if (weightDelta !== 0) return weightDelta;
		return a.title.localeCompare(b.title);
	});

	return rows;
}

/** Fields a type marked required but the event has not filled in yet. */
export function missingFields(
	event: CalendarEvent,
	types: Map<string, EventType>
): string[] {
	const out: string[] = [];
	if (!event.date) out.push("date");
	for (const id of event.types) {
		for (const field of types.get(id)?.fields ?? []) {
			if (!field.required) continue;
			const value = event.props[field.key];
			if (value === undefined || value === null || value === "") {
				out.push(field.label);
			}
		}
	}
	return out;
}
