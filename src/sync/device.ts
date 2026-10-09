/**
 * Which computer syncs with iCloud, Google and Outlook.
 *
 * A vault can be shared between computers (Obsidian Sync, LiveSync,
 * Syncthing...), settings file included, so the settings alone cannot say
 * "sync from here": every copy would say it. Two copies syncing one account
 * while their notes also sync between them is untested ground -- and the
 * failures this plugin has had (duplicate notes, pushed-back events) were all
 * about two writers seeing each other late.
 *
 * So the shared settings name ONE computer, and each computer keeps its own
 * id in Obsidian's per-device storage, which no vault sync carries. A
 * computer syncs only when the two match. Turning sync on somewhere makes that
 * computer the one, which turns it off everywhere else: two computers can
 * never both believe they are it, whatever the settings file says.
 */

export interface SyncDevice {
	/** The chosen computer's id; empty means no computer syncs. */
	id: string;
	/** Its name as the user would know it (the hostname), for the settings screen. */
	name: string;
}

export function normalizeSyncDevice(value: unknown): SyncDevice | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	return {
		id: typeof raw.id === "string" ? raw.id : "",
		name: typeof raw.name === "string" ? raw.name : "",
	};
}

/** Whether this computer may sync. */
export function isSyncDevice(chosen: SyncDevice | undefined, localId: string): boolean {
	return Boolean(chosen?.id) && chosen!.id === localId;
}

/**
 * Whether this computer should take the role without being asked: only when
 * nobody holds it yet (a vault from before this setting existed, or a first
 * setup) and there is something to sync with. Once any computer holds it, or
 * the user turned it off (an empty id), only the switch changes it.
 */
export function shouldClaim(chosen: SyncDevice | undefined, configured: boolean): boolean {
	return chosen === undefined && configured;
}

export function newDeviceId(): string {
	return `dev-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
