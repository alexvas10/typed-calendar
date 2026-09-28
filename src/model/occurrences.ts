import { CalendarEvent, OccurrenceOverride } from "./types";
import { expandOccurrences } from "./recurrence";

/**
 * One concrete instance of an event: a single event is one, a series is one
 * per date its rule lands on, each with any per-occurrence change applied.
 */
export interface Occurrence {
	/**
	 * The date the rule produced. Identifies the occurrence for skipping and
	 * overriding, and differs from `date` only when it was moved.
	 */
	occurrence: string;
	date: string;
	title: string;
	allDay: boolean;
	startTime?: string;
	endTime?: string;
	location?: string;
	description?: string;
	/** Present when this occurrence was changed on its own. */
	override?: OccurrenceOverride;
}

/**
 * Applies an override to the series' fields. An override that makes the
 * occurrence timed while the series is all-day (or the reverse) decides the
 * shape; one that says nothing about timing inherits the series'.
 */
export function applyOverride(event: CalendarEvent, occurrence: string, override?: OccurrenceOverride): Occurrence {
	const allDay =
		override?.allDay ?? (override?.startTime ? false : event.allDay || !event.startTime);
	const startTime = allDay ? undefined : override?.startTime ?? event.startTime;
	return {
		occurrence,
		date: override?.date ?? occurrence,
		title: override?.title ?? event.title,
		// Timed with no start time anywhere cannot be drawn on a timed grid.
		allDay: allDay || !startTime,
		startTime,
		endTime: allDay || !startTime ? undefined : override?.endTime ?? event.endTime,
		location: override?.location ?? event.location,
		description: override?.description ?? event.description,
		override,
	};
}

/** True when the series actually produces `date`, and it is not skipped. */
export function isOccurrenceOf(event: CalendarEvent, date: string): boolean {
	if (!event.date) return false;
	return (
		expandOccurrences(event.date, event.recurrence, event.exceptions ?? [], {
			from: date,
			to: date,
		}).length > 0
	);
}

/**
 * The overrides that apply to a real occurrence. One whose date the rule no
 * longer produces -- the series was moved to another weekday -- or that was
 * skipped outright is inert: shown nowhere and never written to the server,
 * where a RECURRENCE-ID matching nothing is at best ignored.
 */
export function activeOverrides(event: CalendarEvent): OccurrenceOverride[] {
	if (!event.recurrence || !event.overrides?.length) return [];
	return event.overrides.filter((override) => isOccurrenceOf(event, override.occurrence));
}

/**
 * Every instance of an event that happens within `[from, to]`, in date and
 * time order.
 *
 * A moved occurrence is placed by where it now happens, not where the rule
 * put it: one moved into the window from outside it appears, and one moved
 * out of it does not.
 */
export function expandEvent(
	event: CalendarEvent,
	window: { from: string; to: string }
): Occurrence[] {
	if (!event.date) return [];
	const overrides = new Map(
		(event.recurrence ? event.overrides ?? [] : []).map((override) => [override.occurrence, override])
	);

	const out: Occurrence[] = [];
	for (const date of expandOccurrences(event.date, event.recurrence, event.exceptions ?? [], window)) {
		const override = overrides.get(date);
		// A moved occurrence is placed by the second loop, from where it went.
		if (override?.date && override.date !== date) continue;
		out.push(applyOverride(event, date, override));
	}

	for (const override of overrides.values()) {
		const moved = override.date;
		if (!moved || moved === override.occurrence) continue;
		if (moved < window.from || moved > window.to) continue;
		if (!isOccurrenceOf(event, override.occurrence)) continue;
		out.push(applyOverride(event, override.occurrence, override));
	}

	return out.sort(
		(a, b) =>
			a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? "")
	);
}

/** What one occurrence should look like, as the editor or a drag leaves it. */
export interface OccurrenceChange {
	date: string;
	allDay: boolean;
	startTime?: string;
	endTime?: string;
	/** Empty or absent means "same as the series". */
	title?: string;
	location?: string;
}

/**
 * The override that makes `occurrence` look like `change`, recording only
 * what differs from the series -- so a later change to the series still
 * reaches whatever this occurrence did not deliberately diverge on.
 *
 * Fields the change does not speak to (a description, or a title when only
 * the time was dragged) are carried over from the existing override rather
 * than dropped. Returns null when nothing differs and there was no override
 * to begin with, so a no-op adds nothing to the note.
 */
export function buildOverride(
	event: CalendarEvent,
	occurrence: string,
	change: OccurrenceChange,
	existing?: OccurrenceOverride
): OccurrenceOverride | null {
	const override: OccurrenceOverride = { occurrence };
	const seriesAllDay = event.allDay || !event.startTime;
	if (change.date !== occurrence) override.date = change.date;
	if (change.allDay !== seriesAllDay) override.allDay = change.allDay;
	if (!change.allDay) {
		if (seriesAllDay || change.startTime !== event.startTime) override.startTime = change.startTime;
		if (change.endTime && (seriesAllDay || change.endTime !== event.endTime)) {
			override.endTime = change.endTime;
		}
	}

	const title = change.title === undefined ? existing?.title : change.title.trim();
	if (title && title !== event.title) override.title = title;
	const location = change.location === undefined ? existing?.location : change.location.trim();
	if (location && location !== event.location) override.location = location;
	if (existing?.description) override.description = existing.description;

	if (!existing && Object.keys(override).length === 1) return null;
	return override;
}
