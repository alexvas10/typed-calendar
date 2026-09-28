/**
 * Core data model. Everything here mirrors what lives in an event note's
 * frontmatter, so these shapes double as the documented on-disk format.
 */

import { RecurrenceRule } from "./recurrence";

export type FieldType = "number" | "text" | "date" | "select" | "checkbox";

/** A custom field declared by an event type, e.g. an exam's weight. */
export interface TypeField {
	key: string;
	label: string;
	type: FieldType;
	/** Rendered after the value in views, e.g. "%". */
	unit?: string;
	/** Allowed values when type is "select". */
	options?: string[];
	/** Show this field inline in the priority / expecting-soon rows. */
	showInPriority?: boolean;
	/** Expecting Soon flags an event when a required field has no value. */
	required?: boolean;
}

export interface EventType {
	/** Stable key used in an event's `types` list. */
	id: string;
	label: string;
	color: string;
	/** Higher ranks sort first when two events fall on the same date. */
	rank: number;
	fields: TypeField[];
	/**
	 * URL of the iCloud calendar this type maps to, if any.
	 *
	 * CalDAV has no tags: a VEVENT lives in exactly one collection. So an
	 * iCloud calendar is effectively one category, and this mapping is the
	 * projection from the vault's many-types-per-event model onto it. An event
	 * is pushed to the calendar of its highest-ranked mapped type.
	 */
	icloudCalendar?: string;
	/** Id of the Google calendar this type maps to, if any. Same rules as iCloud. */
	googleCalendar?: string;
	/** Id of the Outlook calendar this type maps to, if any. Same rules as iCloud. */
	outlookCalendar?: string;
}

/**
 * The calendar services an event can sync with. The vault is the hub: each
 * service syncs against the notes on its own, so an event pulled from iCloud
 * reaches Google through its note, never directly.
 */
export type ProviderKey = "icloud" | "google" | "outlook";
export const PROVIDERS: readonly ProviderKey[] = ["icloud", "google", "outlook"];

export const PROVIDER_LABELS: Record<ProviderKey, string> = {
	icloud: "iCloud",
	google: "Google",
	outlook: "Outlook",
};

/** Which EventType field holds the calendar a type maps to on each service. */
export const CALENDAR_FIELD: Record<ProviderKey, "icloudCalendar" | "googleCalendar" | "outlookCalendar"> = {
	icloud: "icloudCalendar",
	google: "googleCalendar",
	outlook: "outlookCalendar",
};

export type EventStatus = "confirmed" | "tbd";

/** Sync bookkeeping. Plugin-managed; users should not hand-edit this. */
export interface ICloudMeta {
	collection?: string;
	href?: string;
	etag?: string;
	remoteModified?: string;
	localModified?: string;
	/**
	 * The server copy carries an RRULE.
	 *
	 * On its own this does not stop a push -- a series whose rule the plugin
	 * parsed into `recurrence` is written back rule and all. It is the
	 * combination of this flag with a *missing* `recurrence` block that marks a
	 * series as pull-only: the server repeats it in a way we cannot author, so
	 * anything we wrote would flatten it. See `isPullOnlySeries`.
	 */
	recurring?: boolean;
	/**
	 * Set once a pull has read the server's rule and found it outside the
	 * writable subset. Without it every sync would re-fetch the same series
	 * hoping for a different answer.
	 *
	 * Holds the `RULE_READER_VERSION` that gave up on it. `true` is the
	 * marker from before versions existed. A newer reader re-reads the
	 * series once, since the rule may be one it has since learned to write.
	 */
	unsupportedRule?: boolean | number;
	/**
	 * The event was deleted on this service and, under the default deletion
	 * setting, stays out of it: it is not sent there again. Carries no other
	 * fields. Removing the key from the note sends it again.
	 */
	excluded?: boolean;
}

/**
 * Sync bookkeeping for one service. Every service uses iCloud's shape, so the
 * planner reads them all the same way: `collection` is the calendar (a CalDAV
 * URL, or a Google/Outlook calendar id) and `href` the event within it (a
 * resource URL, or an event id).
 */
export type SyncBinding = ICloudMeta;

/**
 * One occurrence of a series changed on its own -- a lecture moved to Thursday
 * for one week, or held in a different room. Fields left out follow the
 * series. In iCalendar this is a VEVENT with a RECURRENCE-ID.
 */
export interface OccurrenceOverride {
	/**
	 * The date the rule puts this occurrence on. It identifies the occurrence
	 * and never changes, even when `date` moves it elsewhere.
	 */
	occurrence: string;
	/** Where the occurrence actually happens, when it was moved. */
	date?: string;
	allDay?: boolean;
	startTime?: string;
	endTime?: string;
	title?: string;
	location?: string;
	description?: string;
}

export interface CalendarEvent {
	uid: string;
	title: string;
	types: string[];
	/** Absent means unscheduled: excluded from the grid and from sync. */
	date?: string;
	startTime?: string;
	endTime?: string;
	allDay: boolean;
	location?: string;
	description?: string;
	timezone?: string;
	status: EventStatus;
	props: Record<string, unknown>;
	/** Repeat rule. Absent means the event happens once. */
	recurrence?: RecurrenceRule;
	/**
	 * Dates removed from the series -- a class that falls on a holiday. Kept
	 * as whole dates rather than instants: a cancelled occurrence is cancelled
	 * whatever time it would have started.
	 */
	exceptions?: string[];
	/**
	 * Occurrences changed individually. Only meaningful with `recurrence`;
	 * an entry whose occurrence the rule does not produce is ignored.
	 */
	overrides?: OccurrenceOverride[];
	/**
	 * Locked: the plugin never writes, moves or deletes the iCloud copy. The
	 * note still follows the server on pull. For records kept as they are --
	 * a finished course -- where no edit made in the vault should reach the
	 * real calendar.
	 */
	readOnly?: boolean;
	icloud?: ICloudMeta;
	google?: SyncBinding;
	outlook?: SyncBinding;
	/** Vault path of the note backing this event. */
	path: string;
}

/**
 * An event is only a real calendar entry once it has a date and is not
 * explicitly marked TBD. Everything else belongs in Expecting Soon and is
 * never pushed to iCloud.
 */
export function isScheduled(event: CalendarEvent): boolean {
	return Boolean(event.date) && event.status !== "tbd";
}

/**
 * True when the server's copy repeats in a way this plugin did not parse into
 * a rule it can write back.
 *
 * Such an event is pulled and displayed but never written, moved or deleted:
 * regenerating a series we only partly understood is precisely how a real
 * calendar lost its alarms and recurrence rules once already.
 */
export function isPullOnlySeries(event: CalendarEvent): boolean {
	// Any one service is enough. A series the note cannot express must not be
	// copied anywhere else either: the copy would be a single, flattened event.
	return !event.recurrence && PROVIDERS.some((key) => Boolean(event[key]?.recurring));
}

/**
 * True when nothing may be written to the server for this event: either the
 * user locked it, or the server repeats it in a way the note cannot express.
 */
export function isLocked(event: CalendarEvent): boolean {
	return event.readOnly === true || isPullOnlySeries(event);
}
