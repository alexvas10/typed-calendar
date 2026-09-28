import { App, TFile, normalizePath } from "obsidian";
import { CalendarEvent, ProviderKey, SyncBinding } from "../model/types";
import { CalendarRouter } from "./routing";

/**
 * Sync bookkeeping written onto notes, shared by every service. Each helper
 * edits only the one service's link (`icloud:`, `google:`, `outlook:`) and
 * never the note's content, so none of them can look like a user edit.
 */

export interface LinkStamp {
	href: string;
	etag: string;
	remoteModified?: string;
	collection?: string;
	recurring?: boolean;
	unsupportedRule?: number;
}

function fileOf(app: App, event: CalendarEvent): TFile | null {
	const file = app.vault.getAbstractFileByPath(event.path);
	return file instanceof TFile ? file : null;
}

/** Records a successful push: where the event lives and which version it is. */
export async function stampLink(app: App, event: CalendarEvent, key: ProviderKey, meta: LinkStamp): Promise<void> {
	const file = fileOf(app, event);
	if (!file) return;
	const stamp = meta.remoteModified ?? new Date().toISOString();
	await app.fileManager.processFrontMatter(file, (fm) => {
		const link: Record<string, unknown> = {
			...(fm[key] as object),
			collection: meta.collection ?? event[key]?.collection,
			href: meta.href,
			etag: meta.etag,
			remoteModified: stamp,
			localModified: stamp,
			recurring: meta.recurring || undefined,
			unsupportedRule: meta.unsupportedRule || undefined,
			excluded: undefined,
		};
		// A key set to undefined would serialise as an empty YAML value rather
		// than disappearing.
		for (const [name, value] of Object.entries(link)) {
			if (value === undefined) delete link[name];
		}
		fm[key] = link;
	});
}

/**
 * Realigns a link's local stamp to the remote one after a pull, so the next
 * pass does not mistake the write just made for a user edit.
 *
 * Takes the file writeEventNote returned rather than looking it up: a freshly
 * created note is not in the index yet, because metadataCache updates
 * asynchronously, and the lookup would silently find nothing.
 */
export async function realignLink(app: App, file: TFile, key: ProviderKey, remoteModified?: string): Promise<void> {
	const stamp = remoteModified ?? new Date().toISOString();
	await app.fileManager.processFrontMatter(file, (fm) => {
		fm[key] = { ...(fm[key] as object), remoteModified: stamp, localModified: stamp };
	});
}

/** Drops a service link, leaving the note and its other links untouched. */
export async function dropLink(app: App, event: CalendarEvent, key: ProviderKey): Promise<void> {
	const file = fileOf(app, event);
	if (!file) return;
	await app.fileManager.processFrontMatter(file, (fm) => {
		delete fm[key];
	});
}

/**
 * Keeps an event out of one service after it was deleted there: the link is
 * replaced by `{ excluded: true }`, which the planner will not create from.
 */
export async function excludeLink(app: App, event: CalendarEvent, key: ProviderKey): Promise<void> {
	const file = fileOf(app, event);
	if (!file) return;
	await app.fileManager.processFrontMatter(file, (fm) => {
		fm[key] = { excluded: true };
	});
}

/**
 * Copies the about-to-be-overwritten local version into a conflicts folder.
 * Last-edit-wins is only safe if the loser is recoverable.
 */
export async function backupConflict(app: App, eventFolder: string, event: CalendarEvent): Promise<void> {
	const file = fileOf(app, event);
	if (!file) return;
	const folder = normalizePath(`${eventFolder}/.conflicts`);
	try {
		if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const contents = await app.vault.read(file);
		await app.vault.create(`${folder}/${file.basename} ${stamp}.md`, contents);
	} catch (error) {
		console.error("Typed Calendar: could not back up conflicting event", error);
	}
}

/**
 * Every uid written in a note, read from the file list rather than from the
 * index. Deliberately a second source: the index drops its entry for the old
 * path the instant a file is renamed, so for a moment an event exists on disk
 * but not in the map -- and a resource whose note is "missing" gets adopted
 * as a brand new event. Scanning files finds it under whichever path the
 * cache still knows.
 */
export function uidsOnDisk(app: App): Set<string> {
	const uids = new Set<string>();
	for (const file of app.vault.getMarkdownFiles()) {
		const uid = app.metadataCache.getFileCache(file)?.frontmatter?.uid;
		if (typeof uid === "string" && uid) uids.add(uid);
	}
	return uids;
}

/** True when the note changed after the last successful push to this service. */
export function hasUnpushedEdits(link: SyncBinding | undefined): boolean {
	const local = Date.parse(link?.localModified ?? "");
	const remote = Date.parse(link?.remoteModified ?? "");
	if (isNaN(local) || isNaN(remote)) return false;
	return local > remote;
}

/**
 * Gives events already linked to a calendar that calendar's type. Pulling
 * only types an event when it is downloaded, so without this a mapping made
 * after the first sync would never reach existing events. Edits `types`
 * alone and leaves the sync stamps untouched, so it cannot cause a push.
 */
export async function backfillTypes(
	app: App,
	events: CalendarEvent[],
	key: ProviderKey,
	calendarId: string,
	router: CalendarRouter,
	claimed: Set<string>
): Promise<number> {
	let typed = 0;
	for (const event of events) {
		if (event[key]?.collection !== calendarId) continue;
		// This run already wrote this event somewhere, so the link in the index
		// is not necessarily current. An event that has just been moved out
		// still reads as belonging here, and typing it would hand back the very
		// type the user removed to move it in the first place.
		if (claimed.has(event.uid)) continue;
		const next = router.withCalendarType(event.types, calendarId);
		if (next === event.types) continue;
		const file = fileOf(app, event);
		if (!file) continue;
		await app.fileManager.processFrontMatter(file, (fm) => {
			fm.types = next;
		});
		typed++;
	}
	return typed;
}
