import { EventType } from "../model/types";
import { DEFAULT_EVENT_TYPES } from "../model/defaults";

/** One remote calendar the user has chosen to sync. */
export interface SyncedCalendar {
	url: string;
	displayName: string;
	enabled: boolean;
	readOnly: boolean;
}

export interface CalDavSettings {
	serverUrl: string;
	username: string;
	/**
	 * An app-specific password from appleid.apple.com. Obsidian does not
	 * encrypt plugin data, so this sits in plaintext in the vault -- which is
	 * exactly why an app-specific password is required rather than the real
	 * Apple ID password: it is scoped and individually revocable.
	 */
	password: string;
	calendars: SyncedCalendar[];
	/** Where events whose types map to nothing go. Empty means do not push. */
	fallbackCalendar: string;
	/** Automatic sync cadence in minutes; 0 disables the timer. */
	intervalMinutes: number;
	lastSync: string;
}

export interface TypedCalendarSettings {
	/** Folder scanned for event notes. Notes elsewhere are ignored. */
	eventFolder: string;
	eventTypes: EventType[];
	/** Type ids currently visible; empty means "show everything". */
	activeFilters: string[];
	/** How far ahead the priority view looks, in days. */
	priorityHorizonDays: number;
	/** Written into new events when the note does not specify one. */
	defaultTimezone: string;
	/** Emit schema/docs into the event folder so agents can read them. */
	writeAgentDocs: boolean;
	caldav: CalDavSettings;
}

export const DEFAULT_CALDAV: CalDavSettings = {
	serverUrl: "https://caldav.icloud.com",
	username: "",
	password: "",
	calendars: [],
	fallbackCalendar: "",
	intervalMinutes: 15,
	lastSync: "",
};

export const DEFAULT_SETTINGS: TypedCalendarSettings = {
	eventFolder: "Calendar/Events",
	eventTypes: DEFAULT_EVENT_TYPES,
	activeFilters: [],
	priorityHorizonDays: 30,
	defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
	writeAgentDocs: true,
	caldav: DEFAULT_CALDAV,
};

/**
 * Settings arrive from disk as untrusted JSON that may predate the current
 * shape, so merge field by field rather than spreading a stored object over
 * the defaults.
 */
export function normalizeSettings(stored: unknown): TypedCalendarSettings {
	const raw = (stored ?? {}) as Partial<TypedCalendarSettings>;
	const types = Array.isArray(raw.eventTypes) && raw.eventTypes.length > 0
		? raw.eventTypes
		: DEFAULT_SETTINGS.eventTypes;

	return {
		eventFolder: typeof raw.eventFolder === "string" && raw.eventFolder.trim()
			? raw.eventFolder.replace(/^\/+|\/+$/g, "")
			: DEFAULT_SETTINGS.eventFolder,
		eventTypes: types,
		activeFilters: Array.isArray(raw.activeFilters) ? raw.activeFilters : [],
		priorityHorizonDays: typeof raw.priorityHorizonDays === "number" && raw.priorityHorizonDays > 0
			? raw.priorityHorizonDays
			: DEFAULT_SETTINGS.priorityHorizonDays,
		defaultTimezone: typeof raw.defaultTimezone === "string" && raw.defaultTimezone
			? raw.defaultTimezone
			: DEFAULT_SETTINGS.defaultTimezone,
		writeAgentDocs: raw.writeAgentDocs !== false,
		caldav: normalizeCalDav(raw.caldav),
	};
}

function normalizeCalDav(stored: unknown): CalDavSettings {
	const raw = (stored ?? {}) as Partial<CalDavSettings>;
	return {
		serverUrl: typeof raw.serverUrl === "string" && raw.serverUrl.trim()
			? raw.serverUrl.trim()
			: DEFAULT_CALDAV.serverUrl,
		username: typeof raw.username === "string" ? raw.username : "",
		password: typeof raw.password === "string" ? raw.password : "",
		calendars: Array.isArray(raw.calendars) ? raw.calendars : [],
		fallbackCalendar: typeof raw.fallbackCalendar === "string" ? raw.fallbackCalendar : "",
		intervalMinutes: typeof raw.intervalMinutes === "number" && raw.intervalMinutes >= 0
			? raw.intervalMinutes
			: DEFAULT_CALDAV.intervalMinutes,
		lastSync: typeof raw.lastSync === "string" ? raw.lastSync : "",
	};
}

/**
 * A readable, stable id for a new type, derived from its name.
 *
 * Ids end up in every event's `types` list and in the agent documentation, so
 * `lecture` is worth having over `type-m8x2k1`. Renaming a type later does not
 * change its id, which is deliberate: the id is what events reference, and
 * rewriting it would orphan every note carrying it.
 */
export function uniqueTypeId(label: string, existing: EventType[]): string {
	const taken = new Set(existing.map((type) => type.id));
	const base =
		label
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32) || `type-${Date.now().toString(36)}`;
	if (!taken.has(base)) return base;
	for (let n = 2; n < 1000; n++) {
		if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
	}
	throw new Error(`Could not find a free id for "${label}".`);
}

