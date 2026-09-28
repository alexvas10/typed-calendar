import { CalendarEvent, ProviderKey } from "../model/types";
import type { DeleteMode } from "../settings/settings";
import type { SyncAction } from "./plan";

export interface SyncReport {
	pulled: number;
	pushed: number;
	deleted: number;
	moved: number;
	/** Events given their calendar's type. A local edit only; nothing is sent. */
	typed: number;
	/** Planned pushes that matched the server copy and sent nothing. */
	unchanged: number;
	unlinked: number;
	conflicts: number;
	/** Events a service cannot hold (a rule Outlook has no pattern for). */
	skipped: number;
	errors: string[];
}

export function emptyReport(): SyncReport {
	return {
		pulled: 0, pushed: 0, deleted: 0, moved: 0, typed: 0, unchanged: 0, unlinked: 0,
		conflicts: 0, skipped: 0, errors: [],
	};
}

/**
 * State shared by every service's pass in one sync run.
 *
 * Deletions under "delete everywhere" are not carried out the moment an event
 * goes missing from a calendar: it may simply have moved to another calendar
 * on the same service, which that calendar's pass -- possibly later in the
 * run -- reveals. They are collected here and decided once every pass has
 * seen what it can.
 */
export interface RunContext {
	deleteMode: DeleteMode;
	/** Uids seen on each service during this run. */
	seen: Record<ProviderKey, Set<string>>;
	/** Events that went missing from a service, awaiting the end of the run. */
	vanished: { event: CalendarEvent; key: ProviderKey }[];
}

export function newRunContext(deleteMode: DeleteMode): RunContext {
	return {
		deleteMode,
		seen: { icloud: new Set(), google: new Set(), outlook: new Set() },
		vanished: [],
	};
}

/** Actions that change a service, skipped for read-only calendars. */
export function isWrite(action: SyncAction): boolean {
	return (
		action.kind === "create-remote" ||
		action.kind === "update-remote" ||
		action.kind === "delete-remote" ||
		action.kind === "move-remote"
	);
}
