import { App, TFile, TFolder, normalizePath } from "obsidian";
import { CalendarEvent } from "../model/types";
import { applyEventToFrontmatter, generateUid } from "../model/serialize";
import { eventFilePath } from "../views/EventModal";

/** Creates the folder chain if it does not exist yet. */
async function ensureFolder(app: App, folder: string): Promise<void> {
	if (!folder) return;
	const path = normalizePath(folder);
	if (app.vault.getAbstractFileByPath(path) instanceof TFolder) return;
	try {
		await app.vault.createFolder(path);
	} catch (error) {
		// A concurrent create is fine; anything else is not.
		if (!(error instanceof Error) || !/exist/i.test(error.message)) throw error;
	}
}

/** Appends " 2", " 3", ... until the path is free. */
async function uniquePath(app: App, desired: string): Promise<string> {
	if (!app.vault.getAbstractFileByPath(desired)) return desired;
	const base = desired.replace(/\.md$/, "");
	for (let n = 2; n < 1000; n++) {
		const candidate = `${base} ${n}.md`;
		if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
	}
	throw new Error("Could not find a free file name for this event.");
}

/**
 * Persists an event to its note. Creating writes a new file; saving updates
 * frontmatter in place and renames the file when the title or date changed, so
 * the folder stays sorted by date without the user maintaining names.
 */
export async function writeEventNote(
	app: App,
	folder: string,
	event: CalendarEvent,
	isNew: boolean
): Promise<TFile> {
	if (!event.uid) event.uid = generateUid();
	const now = new Date().toISOString();
	event.icloud = { ...event.icloud, localModified: now };
	// Every other service this note is linked to is now behind it too. This is
	// what carries a change across services: a pull from iCloud rewrites the
	// note, which marks the Google copy stale, which the Google pass pushes.
	// The service a pull came from realigns its own stamp afterwards.
	for (const key of ["google", "outlook"] as const) {
		const binding = event[key];
		if (binding?.href) event[key] = { ...binding, localModified: now };
	}

	if (isNew) {
		await ensureFolder(app, folder);
		const path = await uniquePath(app, eventFilePath(folder, event));
		const file = await app.vault.create(path, "");
		await app.fileManager.processFrontMatter(file, (fm) =>
			applyEventToFrontmatter({ ...event, path }, fm)
		);
		return file;
	}

	const existing = app.vault.getAbstractFileByPath(event.path);
	if (!(existing instanceof TFile)) {
		throw new Error(`Event note not found: ${event.path}`);
	}

	await app.fileManager.processFrontMatter(existing, (fm) =>
		applyEventToFrontmatter(event, fm)
	);

	const desired = eventFilePath(folder, event);
	if (desired !== existing.path) {
		const target = await uniquePath(app, desired);
		// fileManager.renameFile updates inbound links; vault.rename does not.
		await app.fileManager.renameFile(existing, target);
	}
	return existing;
}
