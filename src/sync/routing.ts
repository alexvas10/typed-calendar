import { CalendarEvent, EventType } from "../model/types";

/**
 * Decides which iCloud calendar an event belongs in, and which event type an
 * incoming iCloud event should be tagged with.
 *
 * The two directions are deliberately asymmetric. Outbound, many types
 * collapse to one collection, chosen by rank. Inbound, one collection
 * contributes one type, which is merged into whatever the event already has
 * rather than replacing it.
 */
export class CalendarRouter {
	private readonly byType: Map<string, EventType>;

	constructor(
		private readonly types: EventType[],
		/** Where events with no mapped type go. Empty disables their push. */
		private readonly fallbackCalendar: string
	) {
		this.byType = new Map(types.map((type) => [type.id, type]));
	}

	/**
	 * The calendar this event should live in: the mapped calendar of its
	 * highest-ranked type, else the fallback. Undefined means "do not push",
	 * which is what an unconfigured setup should do rather than guessing.
	 */
	routeFor(event: CalendarEvent): string | undefined {
		let best: EventType | undefined;
		for (const id of event.types) {
			const type = this.byType.get(id);
			if (!type?.icloudCalendar) continue;
			if (!best || type.rank > best.rank) best = type;
		}
		return best?.icloudCalendar ?? (this.fallbackCalendar || undefined);
	}

	/** The type id an event pulled from this calendar should carry. */
	typeForCalendar(calendarUrl: string): string | undefined {
		return this.types.find((type) => type.icloudCalendar === calendarUrl)?.id;
	}

	/** Adds the calendar's type without disturbing types already present. */
	withCalendarType(existing: string[], calendarUrl: string): string[] {
		const typeId = this.typeForCalendar(calendarUrl);
		if (!typeId || existing.includes(typeId)) return existing;
		return [...existing, typeId];
	}
}

/** Calendar names that clearly imply an existing or standard type. */
const NAME_SYNONYMS: Record<string, string> = {
	assignment: "assignment",
	assignments: "assignment",
	homework: "assignment",
	evaluation: "exam",
	evaluations: "exam",
	exam: "exam",
	exams: "exam",
	test: "exam",
	tests: "exam",
	midterms: "exam",
	class: "class",
	classes: "class",
	lecture: "class",
	lectures: "class",
	school: "class",
	home: "personal",
	personal: "personal",
	family: "personal",
	work: "work",
	job: "work",
	payment: "payment",
	payments: "payment",
	bills: "payment",
	finance: "payment",
};

const GENERATED_DEFAULTS: Record<string, { label: string; color: string; rank: number }> = {
	work: { label: "Work", color: "#7b5ea7", rank: 15 },
	payment: { label: "Payment", color: "#2f8f74", rank: 25 },
	personal: { label: "Personal", color: "#6b8e5a", rank: 10 },
	class: { label: "Class", color: "#3d7ea6", rank: 5 },
	exam: { label: "Exam", color: "#c0392b", rank: 30 },
	assignment: { label: "Assignment", color: "#d98324", rank: 20 },
};

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export interface AutoMapResult {
	types: EventType[];
	/** Human-readable summary of what was wired to what. */
	mappings: string[];
	created: string[];
}

/**
 * Wires discovered calendars to event types by name, creating types for
 * calendars that have no match. Existing mappings are left alone so a
 * re-discovery does not undo manual choices.
 */
export function autoMapCalendars(
	types: EventType[],
	calendars: { url: string; displayName: string }[]
): AutoMapResult {
	const next = types.map((type) => ({ ...type }));
	const mappings: string[] = [];
	const created: string[] = [];

	const claimed = new Set(
		next.map((type) => type.icloudCalendar).filter((url): url is string => Boolean(url))
	);

	for (const calendar of calendars) {
		if (claimed.has(calendar.url)) continue;

		const key = slugify(calendar.displayName);
		const synonym = NAME_SYNONYMS[key] ?? key;

		// If the natural type is already wired to another calendar, fall back
		// to a type named after this one rather than leaving it unmapped.
		const claimedSynonym = next.find(
			(candidate) => candidate.id === synonym && candidate.icloudCalendar
		);
		const targetId = claimedSynonym ? key : synonym;

		let type = next.find((candidate) => candidate.id === targetId);
		if (type?.icloudCalendar) continue;

		if (!type) {
			const preset = GENERATED_DEFAULTS[targetId];
			type = {
				id: targetId,
				label: preset?.label ?? calendar.displayName,
				color: preset?.color ?? "#888888",
				rank: preset?.rank ?? 10,
				fields: [],
			};
			next.push(type);
			created.push(type.label);
		}

		type.icloudCalendar = calendar.url;
		claimed.add(calendar.url);
		mappings.push(`${calendar.displayName} → ${type.label}`);
	}

	return { types: next, mappings, created };
}
