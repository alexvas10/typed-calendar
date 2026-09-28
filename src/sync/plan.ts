import { CalendarEvent, ProviderKey, SyncBinding, isLocked, isScheduled } from "../model/types";
import { ParsedVEvent } from "./ics";
import { CalDavResource } from "./caldav";

/**
 * Pure decision layer for a sync pass.
 *
 * Deciding what to do is separated from doing it so the conflict rules can be
 * tested exhaustively without a server or a vault.
 */

export type SyncAction =
	| { kind: "create-local"; remote: ParsedVEvent; href: string; etag: string }
	| { kind: "update-local"; event: CalendarEvent; remote: ParsedVEvent; href: string; etag: string }
	| { kind: "create-remote"; event: CalendarEvent }
	| { kind: "update-remote"; event: CalendarEvent }
	| { kind: "delete-remote"; event: CalendarEvent }
	| { kind: "move-remote"; event: CalendarEvent; from: string; to: string }
	| { kind: "unlink-local"; event: CalendarEvent };

/** Reads one service's link off an event. */
export type BindingOf = (event: CalendarEvent) => SyncBinding | undefined;

/** The planner's default service, which is also the one every test uses. */
const icloudBinding: BindingOf = (event) => event.icloud;

/** The link accessor for a service. */
export function bindingFor(key: ProviderKey): BindingOf {
	return (event) => event[key];
}

export interface PlanInput {
	/**
	 * Which service's link to read. Every service shares this planner; only
	 * the key its bookkeeping lives under differs. Defaults to iCloud.
	 */
	binding?: BindingOf;
	/** Local events already bound to this calendar, plus any unbound ones. */
	localEvents: CalendarEvent[];
	/** Every resource the server currently holds, with its ETag. */
	remoteResources: CalDavResource[];
	/** Parsed bodies, keyed by href, for resources whose ETag changed. */
	fetched: Map<string, ParsedVEvent>;
	calendarUrl: string;
	/**
	 * Which calendar an event belongs in, from the type mapping. Undefined
	 * means the event has no route and must not be pushed anywhere -- without
	 * this, every enabled calendar would claim every unbound event.
	 */
	routeFor: (event: CalendarEvent) => string | undefined;
	/**
	 * Every uid that exists anywhere in the vault, not just in this calendar.
	 *
	 * `localEvents` is filtered to this collection, so an event bound to a
	 * different calendar looks absent here -- and a resource whose note simply
	 * lives elsewhere would be adopted as a brand new event. That is how one
	 * event became three notes: a move wrote the resource into the destination
	 * calendar, and the destination's own pass, running moments later against an
	 * index that had not caught up, created a note for it.
	 */
	knownUids?: Set<string>;
	/**
	 * Uids this sync run has already written somewhere. Narrower than
	 * `knownUids` and used for the opposite case: not adopting a resource, but
	 * not unlinking a note whose binding this run just changed.
	 */
	claimedUids?: Set<string>;
}

/**
 * Bumped whenever the reader learns to write a kind of series it used to
 * refuse. Series marked unsupported by an older reader are read again once.
 *
 * 1: weekly weekdays, until/count, EXDATE.
 * 2: positional rules ("the 2nd Tuesday", "the last weekday") and
 *    per-occurrence overrides.
 */
export const RULE_READER_VERSION = 2;

/** The `unsupportedRule` marker for a pulled VEVENT, or undefined if we own it. */
export function unsupportedMarker(remote: { recurring: boolean; recurrence?: unknown } | null | undefined): number | undefined {
	return remote && remote.recurring && !remote.recurrence ? RULE_READER_VERSION : undefined;
}

/** Resources whose ETag differs from what the local copy last saw. */
export function resourcesNeedingFetch(
	localEvents: CalendarEvent[],
	remoteResources: CalDavResource[],
	binding: BindingOf = icloudBinding
): string[] {
	const knownEtags = new Map<string, string>();
	for (const event of localEvents) {
		const link = binding(event);
		if (link?.href && link.etag) knownEtags.set(link.href, link.etag);
	}
	// A series recorded before the plugin could read rules has no local
	// `recurrence` block, so its ETag matches and it would never be looked at
	// again. Fetch it once more to learn its rule; `unsupportedRule` records
	// the answer when the rule turns out to be one we cannot author, so this
	// re-reads each such event once per reader version rather than every sync.
	const unread = new Set(
		localEvents
			.filter(
				(event) =>
					binding(event)?.href &&
					binding(event)?.recurring &&
					!event.recurrence &&
					binding(event)?.unsupportedRule !== RULE_READER_VERSION
			)
			.map((event) => binding(event)!.href as string)
	);

	return remoteResources
		.filter(
			(resource) => knownEtags.get(resource.href) !== resource.etag || unread.has(resource.href)
		)
		.map((resource) => resource.href);
}

function timestamp(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return isNaN(parsed) ? 0 : parsed;
}

/**
 * Decides, per event, which side wins.
 *
 * Last edit wins: the link's `localModified` stamp is compared against
 * the VEVENT's LAST-MODIFIED. A local event that has never been pushed always
 * wins, and a remote event we have never seen is always adopted.
 */
export function planSync(input: PlanInput): SyncAction[] {
	const { localEvents, remoteResources, fetched, calendarUrl, routeFor } = input;
	const binding = input.binding ?? icloudBinding;
	const knownUids = input.knownUids ?? new Set<string>();
	const claimedUids = input.claimedUids ?? new Set<string>();
	const actions: SyncAction[] = [];

	const etagByHref = new Map(remoteResources.map((r) => [r.href, r.etag]));
	const localByUid = new Map<string, CalendarEvent>();
	for (const event of localEvents) {
		if (event.uid) localByUid.set(event.uid, event);
	}
	const handledUids = new Set<string>();

	// --- remote -> local ---
	for (const [href, remote] of fetched) {
		const local = localByUid.get(remote.uid);
		const etag = etagByHref.get(href) ?? "";

		if (!local) {
			// A note for this uid exists, it is just bound to another calendar or
			// has not been re-indexed yet. Adopting it would fork the event into a
			// second note; the pass that owns it will reconcile it instead.
			if (knownUids.has(remote.uid)) continue;
			actions.push({ kind: "create-local", remote, href, etag });
			continue;
		}
		handledUids.add(remote.uid);

		const localTime = timestamp(binding(local)?.localModified);
		const remoteTime = timestamp(remote.remoteModified);

		// A series whose rule we could not read back stays pull-only: the note
		// cannot express it, so anything we sent would flatten it. A rule we
		// did parse is an ordinary event as far as conflicts go. A locked
		// event is pull-only by the user's choice, so the server always wins.
		if ((remote.recurring && !remote.recurrence) || isLocked(local)) {
			actions.push({ kind: "update-local", event: local, remote, href, etag });
		} else if (remoteTime >= localTime) {
			actions.push({ kind: "update-local", event: local, remote, href, etag });
		} else {
			actions.push({ kind: "update-remote", event: local });
		}
	}

	// --- local -> remote ---
	for (const event of localEvents) {
		if (handledUids.has(event.uid)) continue;
		const link = binding(event);
		const href = link?.href;
		const boundHere = Boolean(href) && link?.collection === calendarUrl;
		const target = routeFor(event);

		// Never create, write, move or delete a locked event or a series the
		// plugin cannot express.
		if (isLocked(event)) continue;

		// An unbound event is only this calendar's business if it routes here --
		// and not at all once it was deleted on this service and the user's
		// deletion setting keeps it out.
		if (!href) {
			if (link?.excluded) continue;
			if (target === calendarUrl && isScheduled(event)) {
				actions.push({ kind: "create-remote", event });
			}
			continue;
		}
		if (!boundHere) continue;

		// An event that lost its date, or was marked TBD, is no longer a
		// calendar entry and must come back off the server.
		if (!isScheduled(event)) {
			actions.push({ kind: "delete-remote", event });
			continue;
		}

		// Retyping an event can change which calendar it belongs to. CalDAV
		// has no move, so this becomes a delete here plus a create there.
		if (target && target !== calendarUrl) {
			actions.push({ kind: "move-remote", event, from: calendarUrl, to: target });
			continue;
		}

		if (!etagByHref.has(href)) {
			// This run moved the event out of this calendar and the note's stamp
			// has not been re-indexed yet. Unlinking here would strip the binding
			// we just wrote and push a duplicate next pass.
			if (claimedUids.has(event.uid)) continue;
			// We hold a link to a resource the server no longer lists: it was
			// deleted elsewhere. Unlinking keeps the note and lets the user
			// decide, rather than silently deleting their writing.
			actions.push({ kind: "unlink-local", event });
			continue;
		}

		// Unchanged ETag means the fetch skipped it, so only a local edit
		// since the last push is worth sending.
		const pushed = timestamp(link?.remoteModified);
		if (timestamp(link?.localModified) > pushed) {
			actions.push({ kind: "update-remote", event });
		}
	}

	return actions;
}

/**
 * Merges a remote VEVENT into a local event. Types and custom props are
 * vault-owned: they are only replaced when the remote actually carries the
 * mirrored X- properties, never cleared because a server stripped them.
 */
export function mergeRemote(
	event: CalendarEvent,
	remote: ParsedVEvent,
	href: string,
	etag: string,
	calendarUrl: string,
	/** Merges the calendar's mapped type in without dropping the others. */
	addTypes: (existing: string[]) => string[] = (existing) => existing,
	/** Which service the remote copy came from, i.e. which link to update. */
	key: ProviderKey = "icloud"
): CalendarEvent {
	return {
		...event,
		title: remote.title,
		date: remote.date,
		startTime: remote.startTime,
		endTime: remote.endTime,
		allDay: remote.allDay,
		location: remote.location ?? event.location,
		description: remote.description ?? event.description,
		types: addTypes(remote.types ?? event.types),
		props: remote.props ?? event.props,
		// Unlike types and props, a rule and its exclusions are standard
		// iCalendar that round-trips intact, so the server's copy simply wins.
		// Clearing `recurrence` when the server's rule stopped being readable
		// is deliberate: it is what puts the event back into pull-only.
		recurrence: remote.recurrence,
		exceptions: remote.recurrence ? remote.exceptions : undefined,
		overrides: remote.recurrence ? remote.overrides : undefined,
		[key]: {
			...event[key],
			// Seen on this service again, so no longer kept out of it.
			excluded: undefined,
			collection: calendarUrl,
			href,
			etag,
			remoteModified: remote.remoteModified,
			recurring: remote.recurring || undefined,
			unsupportedRule: unsupportedMarker(remote),
			// The local copy now matches the remote, so it is no longer ahead.
			localModified: remote.remoteModified,
		},
	};
}

/**
 * A new note for an event first seen on a service. A pulled event carries no
 * types of its own unless this plugin wrote it, so the calendar it came from
 * supplies one.
 */
export function newEventFromRemote(
	remote: ParsedVEvent,
	key: ProviderKey,
	href: string,
	etag: string,
	calendarId: string,
	addTypes: (existing: string[]) => string[],
	timezone: string,
	uid: string
): CalendarEvent {
	return {
		uid,
		title: remote.title,
		types: addTypes(remote.types ?? []),
		date: remote.date,
		recurrence: remote.recurrence,
		exceptions: remote.recurrence ? remote.exceptions : undefined,
		overrides: remote.recurrence ? remote.overrides : undefined,
		startTime: remote.startTime,
		endTime: remote.endTime,
		allDay: remote.allDay,
		location: remote.location,
		description: remote.description,
		timezone,
		status: "confirmed",
		props: remote.props ?? {},
		[key]: {
			collection: calendarId,
			href,
			etag,
			remoteModified: remote.remoteModified,
			localModified: remote.remoteModified,
			recurring: remote.recurring || undefined,
			unsupportedRule: unsupportedMarker(remote),
		},
		path: "",
	};
}
