import { CalendarEvent, EventStatus, ICloudMeta } from "./types";
import { parseExceptions, parseRecurrence, recurrenceToFrontmatter } from "./recurrence";

/** Frontmatter keys the plugin owns. Anything else on a note is left alone. */
export const MANAGED_KEYS = [
	"uid",
	"title",
	"types",
	"date",
	"startTime",
	"endTime",
	"allDay",
	"location",
	"description",
	"timezone",
	"status",
	"props",
	"recurrence",
	"exceptions",
	"icloud",
] as const;

function asString(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof value === "number") return String(value);
	return undefined;
}

/**
 * Dates arrive as either a string or, when Obsidian's YAML parser recognises
 * the shape, a Date. Normalise both to YYYY-MM-DD in local time -- using the
 * UTC accessors here would shift the date backwards west of Greenwich.
 */
function asDate(value: unknown): string | undefined {
	if (value instanceof Date && !isNaN(value.valueOf())) {
		const y = value.getFullYear();
		const m = String(value.getMonth() + 1).padStart(2, "0");
		const d = String(value.getDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}
	const raw = asString(value);
	if (!raw) return undefined;
	const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
	return match ? match[1] : undefined;
}

/** Accepts "9:05", "09:05", "09:05:30" and normalises to HH:mm. */
function asTime(value: unknown): string | undefined {
	const raw = asString(value);
	if (!raw) return undefined;
	const match = raw.match(/^(\d{1,2}):(\d{2})/);
	if (!match) return undefined;
	const hours = Number(match[1]);
	if (hours > 23 || Number(match[2]) > 59) return undefined;
	return `${String(hours).padStart(2, "0")}:${match[2]}`;
}

function asStringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map(asString).filter((v): v is string => Boolean(v));
	}
	const single = asString(value);
	if (!single) return [];
	// Tolerate `types: exam, cs3600` written as a bare comma list.
	return single
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return { ...(value as Record<string, unknown>) };
	}
	return {};
}

/**
 * Builds an event from a note's frontmatter. Returns null when the note is not
 * an event at all, so the index can cheaply skip unrelated notes in the folder.
 */
export function eventFromFrontmatter(
	frontmatter: Record<string, unknown> | undefined,
	path: string,
	fallbackTitle: string
): CalendarEvent | null {
	if (!frontmatter) return null;

	const types = asStringList(frontmatter.types);
	const date = asDate(frontmatter.date);
	const uid = asString(frontmatter.uid);

	// A note earns a place in the index if it carries any managed signal at
	// all. Requiring a date here would hide exactly the undated events that
	// Expecting Soon exists to surface.
	if (!uid && types.length === 0 && !date) return null;

	const rawStatus = asString(frontmatter.status)?.toLowerCase();
	const status: EventStatus = rawStatus === "tbd" ? "tbd" : "confirmed";

	const exceptions = parseExceptions(frontmatter.exceptions);
	const startTime = asTime(frontmatter.startTime);
	const endTime = asTime(frontmatter.endTime);
	// An event with no start time cannot be drawn on a timed grid, so treat it
	// as all-day regardless of what the note claims.
	const allDay = frontmatter.allDay === true || !startTime;

	return {
		uid: uid ?? "",
		title: asString(frontmatter.title) ?? fallbackTitle,
		types,
		date,
		startTime: allDay ? undefined : startTime,
		endTime: allDay ? undefined : endTime,
		allDay,
		location: asString(frontmatter.location),
		description: asString(frontmatter.description),
		timezone: asString(frontmatter.timezone),
		status,
		props: asRecord(frontmatter.props),
		recurrence: parseRecurrence(frontmatter.recurrence) ?? undefined,
		exceptions: exceptions.length > 0 ? exceptions : undefined,
		icloud: frontmatter.icloud ? (asRecord(frontmatter.icloud) as ICloudMeta) : undefined,
		path,
	};
}

/**
 * Writes the event back onto a frontmatter object in place, which is the shape
 * Obsidian's processFrontMatter callback hands us. Keys are deleted rather
 * than set to null so cleared fields do not linger as empty YAML entries.
 */
export function applyEventToFrontmatter(
	event: CalendarEvent,
	frontmatter: Record<string, unknown>
): void {
	const set = (key: string, value: unknown) => {
		if (value === undefined || value === "" || value === null) {
			delete frontmatter[key];
		} else {
			frontmatter[key] = value;
		}
	};

	set("uid", event.uid);
	set("title", event.title);
	frontmatter.types = event.types;
	set("date", event.date);
	set("startTime", event.allDay ? undefined : event.startTime);
	set("endTime", event.allDay ? undefined : event.endTime);
	frontmatter.allDay = event.allDay;
	set("location", event.location);
	set("description", event.description);
	set("timezone", event.timezone);
	set("status", event.status);
	set("props", Object.keys(event.props).length > 0 ? event.props : undefined);
	set("recurrence", event.recurrence ? recurrenceToFrontmatter(event.recurrence) : undefined);
	// An exception list without a rule is meaningless, and leaving one behind
	// after a series is made single would silently hide the event.
	set(
		"exceptions",
		event.recurrence && event.exceptions?.length ? [...event.exceptions].sort() : undefined
	);
	set("icloud", event.icloud && Object.keys(event.icloud).length > 0 ? event.icloud : undefined);
}

/** Collision-resistant enough for a single vault, and readable in YAML. */
export function generateUid(): string {
	const stamp = Date.now().toString(36);
	const noise = Math.random().toString(36).slice(2, 8);
	return `evt-${stamp}${noise}`;
}
