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
	event.icloud = { ...event.icloud, localModified: new Date().toISOString() };

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
