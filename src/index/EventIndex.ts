import { App, Component, TAbstractFile, TFile } from "obsidian";
import { CalendarEvent, isScheduled } from "../model/types";
import { eventFromFrontmatter } from "../model/serialize";

type Listener = () => void;

/**
 * Keeps an in-memory view of every event note under the configured folder.
 *
 * Reads go through Obsidian's metadataCache rather than parsing files
 * ourselves: the cache is already populated, already invalidated on edit, and
 * means an agent dropping a .md file into the folder shows up without any
 * cooperation from the plugin.
 */
export class EventIndex extends Component {
	private events = new Map<string, CalendarEvent>();
	private listeners = new Set<Listener>();
	private folder: string;

	constructor(private app: App, folder: string) {
		super();
		this.folder = normalizeFolder(folder);
	}

	onload(): void {
		// metadataCache fires resolved/changed only once the cache is warm, so
		// defer the initial sweep instead of reading a half-built cache.
		this.app.workspace.onLayoutReady(() => this.rebuild());

		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (this.inScope(file.path)) this.reindex(file);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (this.events.delete(file.path)) this.notify();
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const previous = this.events.get(oldPath);
				const had = this.events.delete(oldPath);
				if (!(file instanceof TFile) || !this.inScope(file.path)) {
					if (had) this.notify();
					return;
				}

				const event = this.read(file);
				if (event) {
					this.events.set(file.path, event);
				} else if (previous) {
					// metadataCache is keyed by path and has not caught up with the
					// new one yet, so the file reads as having no frontmatter. Carry
					// the previous parse across rather than letting the event drop
					// out of the index: an event that is briefly absent looks to the
					// planner like a remote resource nothing local owns, and gets
					// adopted as a second note for the same uid. The "changed" event
					// that follows refreshes it properly.
					this.events.set(file.path, { ...previous, path: file.path });
				} else if (!had) {
					return;
				}
				this.notify();
			})
		);
	}

	onunload(): void {
		this.listeners.clear();
		this.events.clear();
	}

	setFolder(folder: string): void {
		const next = normalizeFolder(folder);
		if (next === this.folder) return;
		this.folder = next;
		this.rebuild();
	}

	onChange(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	all(): CalendarEvent[] {
		return Array.from(this.events.values());
	}

	/** Events with a usable date -- the ones the calendar grid draws. */
	scheduled(): CalendarEvent[] {
		return this.all().filter(isScheduled);
	}

	/** Undated or explicitly TBD events -- the Expecting Soon backlog. */
	unscheduled(): CalendarEvent[] {
		return this.all().filter((event) => !isScheduled(event));
	}

	byPath(path: string): CalendarEvent | undefined {
		return this.events.get(path);
	}

	byUid(uid: string): CalendarEvent | undefined {
		if (!uid) return undefined;
		return this.all().find((event) => event.uid === uid);
	}

	rebuild(): void {
		this.events.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.inScope(file.path)) continue;
			const event = this.read(file);
			if (event) this.events.set(file.path, event);
		}
		this.notify();
	}

	private reindex(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const event = this.read(file);
		if (event) {
			this.events.set(file.path, event);
		} else if (!this.events.delete(file.path)) {
			// Not an event before, not an event now -- nothing to broadcast.
			return;
		}
		this.notify();
	}

	private read(file: TFile): CalendarEvent | null {
		const cache = this.app.metadataCache.getFileCache(file);
		return eventFromFrontmatter(cache?.frontmatter, file.path, file.basename);
	}

	private inScope(path: string): boolean {
		if (!path.endsWith(".md")) return false;
		// An empty folder setting means the whole vault is in scope.
		if (!this.folder) return true;
		return path.startsWith(`${this.folder}/`);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}

function normalizeFolder(folder: string): string {
	return folder.replace(/^\/+|\/+$/g, "");
}
