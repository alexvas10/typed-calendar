import { Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { EventIndex } from "./src/index/EventIndex";
import { writeEventNote } from "./src/index/writer";
import { EventModal } from "./src/views/EventModal";
import { CalendarEvent, isPullOnlySeries } from "./src/model/types";
import { SyncEngine } from "./src/sync/SyncEngine";
import { writeAgentDocs } from "./src/agent/docs";
import { EventType } from "./src/model/types";
import { generateUid } from "./src/model/serialize";
import {
	DEFAULT_SETTINGS,
	TypedCalendarSettings,
	normalizeSettings,
	uniqueTypeId,
} from "./src/settings/settings";
import { TypedCalendarSettingTab } from "./src/settings/SettingsTab";
import { CalendarGridView } from "./src/views/CalendarView";
import { PriorityView } from "./src/views/PriorityView";
import { ExpectingSoonView } from "./src/views/ExpectingSoonView";
import {
	CALENDAR_VIEW,
	EXPECTING_VIEW,
	PRIORITY_VIEW,
} from "./src/views/shared";

type RefreshableView = CalendarGridView | PriorityView | ExpectingSoonView;

const VIEW_TYPES = [CALENDAR_VIEW, PRIORITY_VIEW, EXPECTING_VIEW];

export default class TypedCalendarPlugin extends Plugin {
	settings: TypedCalendarSettings = DEFAULT_SETTINGS;
	index!: EventIndex;
	sync!: SyncEngine;
	private syncTimer: number | null = null;
	/** Signature of the last docs write, so unrelated saves do not rewrite them. */
	private docsSignature = "";

	/**
	 * Optional scripted surface for agents and Templater. Writing event notes
	 * directly is the supported path; this is a convenience on top.
	 */
	readonly api = {
		listEvents: (): CalendarEvent[] => this.index.all(),
		listScheduled: (): CalendarEvent[] => this.index.scheduled(),
		listUnscheduled: (): CalendarEvent[] => this.index.unscheduled(),
		createType: (label: string, color = "#888888", rank = 10) =>
			this.createType(label, color, rank),
		listTypes: (): EventType[] => this.settings.eventTypes,
		createEvent: (event: Partial<CalendarEvent>) =>
			this.writeEvent(
				{
					uid: event.uid ?? generateUid(),
					title: event.title ?? "Untitled event",
					types: event.types ?? [],
					date: event.date,
					startTime: event.startTime,
					endTime: event.endTime,
					allDay: event.allDay ?? !event.startTime,
					location: event.location,
					description: event.description,
					timezone: event.timezone ?? this.settings.defaultTimezone,
					status: event.status ?? "confirmed",
					props: event.props ?? {},
					recurrence: event.recurrence,
					exceptions: event.exceptions,
					path: "",
				},
				true
			),
		updateEvent: (event: CalendarEvent) => this.writeEvent(event, false),
		/** Removes the event from iCloud and then from the vault, in that order. */
		deleteEvent: (uid: string) => {
			const event = this.index.byUid(uid);
			if (!event) throw new Error(`No event with uid ${uid}.`);
			return this.deleteEvent(event);
		},
		/**
		 * Removes one date from a repeating event -- the holiday case -- leaving
		 * the rest of the series alone.
		 */
		skipOccurrence: (uid: string, date: string) => this.setOccurrenceSkipped(uid, date, true),
		restoreOccurrence: (uid: string, date: string) =>
			this.setOccurrenceSkipped(uid, date, false),
		sync: () => this.sync.run(),
	};

	async onload(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());

		this.index = new EventIndex(this.app, this.settings.eventFolder);
		this.addChild(this.index);

		this.sync = new SyncEngine(this.app, this);

		this.registerView(CALENDAR_VIEW, (leaf) => new CalendarGridView(leaf, this));
		this.registerView(PRIORITY_VIEW, (leaf) => new PriorityView(leaf, this));
		this.registerView(EXPECTING_VIEW, (leaf) => new ExpectingSoonView(leaf, this));

		this.addSettingTab(new TypedCalendarSettingTab(this.app, this));

		this.addRibbonIcon("calendar-days", "Open calendar", () => {
			void this.activateView(CALENDAR_VIEW, "tab");
		});

		this.addCommand({
			id: "open-calendar",
			name: "Open calendar",
			callback: () => void this.activateView(CALENDAR_VIEW, "tab"),
		});
		this.addCommand({
			id: "open-priority",
			name: "Open priority view",
			callback: () => void this.activateView(PRIORITY_VIEW, "right"),
		});
		this.addCommand({
			id: "open-expecting-soon",
			name: "Open expecting soon",
			callback: () => void this.activateView(EXPECTING_VIEW, "right"),
		});
		this.app.workspace.onLayoutReady(() => {
			this.rescheduleSync();
			void this.refreshAgentDocs();
		});

		this.addCommand({
			id: "new-event",
			name: "New event",
			callback: () => this.openEventModal(),
		});
		this.addCommand({
			id: "write-agent-docs",
			name: "Write agent documentation",
			callback: () => void this.refreshAgentDocs(true),
		});
		this.addCommand({
			id: "sync-now",
			name: "Sync with iCloud now",
			callback: () => void this.sync.run(),
		});
		this.addCommand({
			id: "rebuild-event-index",
			name: "Rebuild event index",
			callback: () => this.index.rebuild(),
		});
	}

	/**
	 * Reuses an existing leaf for the view type if one is already open, so
	 * repeated command invocations reveal the view instead of stacking copies.
	 */
	async activateView(type: string, placement: "tab" | "right"): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(type);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		let leaf: WorkspaceLeaf | null;
		if (placement === "right") {
			leaf = this.app.workspace.getRightLeaf(false);
		} else {
			leaf = this.app.workspace.getLeaf("tab");
		}
		if (!leaf) return;

		await leaf.setViewState({ type, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Saves an event note and returns the file. The index picks the change up
	 * through metadataCache, so nothing here touches the in-memory map.
	 */
	async writeEvent(event: CalendarEvent, isNew: boolean): Promise<TFile> {
		return writeEventNote(this.app, this.settings.eventFolder, event, isNew);
	}

	/**
	 * Adds or removes a date in a repeating event's exception list. Written
	 * through the normal event path so the change syncs out as an EXDATE.
	 */
	async setOccurrenceSkipped(uid: string, date: string, skipped: boolean): Promise<TFile> {
		const event = this.index.byUid(uid);
		if (!event) throw new Error(`No event with uid ${uid}.`);
		if (!event.recurrence) throw new Error(`"${event.title}" does not repeat.`);

		const dates = new Set(event.exceptions ?? []);
		if (skipped) dates.add(date);
		else dates.delete(date);
		return this.writeEvent(
			{ ...event, exceptions: dates.size > 0 ? Array.from(dates).sort() : undefined },
			false
		);
	}

	/**
	 * Removes an event from iCloud and then from the vault.
	 *
	 * The server copy goes first and on purpose: a note deleted while its
	 * resource still exists is not a deletion at all, because the next pull
	 * finds a remote event with no local copy and downloads it straight back as
	 * a new note. If the server refuses, the note is left alone so the two sides
	 * stay in step.
	 */
	async deleteEvent(event: CalendarEvent): Promise<void> {
		// A series the plugin cannot author is one it also must not delete: the
		// note describes only what we could read, so removing the resource would
		// throw away occurrences and overrides we never modelled.
		if (isPullOnlySeries(event)) {
			throw new Error(
				`"${event.title}" repeats in a way this plugin cannot author, so it will not delete it. Remove it in Apple Calendar instead.`
			);
		}

		const href = event.icloud?.href;
		if (href) {
			try {
				await this.sync.client().delete(href, event.icloud?.etag);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Could not remove "${event.title}" from iCloud: ${message}`);
			}
		}

		const file = this.app.vault.getAbstractFileByPath(event.path);
		if (file) await this.app.fileManager.trashFile(file);
	}

	openEventModal(existing?: CalendarEvent, prefillDate?: string, occurrence?: string): void {
		new EventModal(this.app, this, existing, prefillDate, occurrence).open();
	}

	/**
	 * Adds an event type. Used by the calendar's "New type" chip, so a type can
	 * be made while looking at the schedule rather than in settings.
	 *
	 * Only the three things needed to start using one; fields and the iCloud
	 * mapping are settings, and the type works without either.
	 */
	async createType(label: string, color: string, rank: number): Promise<EventType> {
		const type: EventType = {
			id: uniqueTypeId(label, this.settings.eventTypes),
			label: label.trim(),
			color,
			rank,
			fields: [],
		};
		this.settings.eventTypes.push(type);
		await this.saveSettings();
		// The docs list every type and their fields, so they go stale the moment
		// one is added -- an agent reading them would use an id that is missing.
		void this.refreshAgentDocs();
		return type;
	}

	/** Toggles a type chip; the sentinel "__clear__" resets the whole set. */
	async toggleFilter(typeId: string): Promise<void> {
		if (typeId === "__clear__") {
			this.settings.activeFilters = [];
		} else {
			const active = this.settings.activeFilters;
			this.settings.activeFilters = active.includes(typeId)
				? active.filter((id) => id !== typeId)
				: [...active, typeId];
		}
		await this.saveSettings();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.index.setFolder(this.settings.eventFolder);
		this.rescheduleSync();
		void this.refreshAgentDocs();
		this.refreshViews();
	}

	/**
	 * Keeps the emitted schema in step with the live types. Stale
	 * event-types.json is worse than no file, since an agent would trust it.
	 */
	async refreshAgentDocs(force = false): Promise<void> {
		if (!this.settings.writeAgentDocs && !force) return;
		const signature = JSON.stringify([this.settings.eventFolder, this.settings.eventTypes]);
		if (!force && signature === this.docsSignature) return;
		this.docsSignature = signature;
		await writeAgentDocs(this.app, this.settings.eventFolder, this.settings.eventTypes);
	}

	/**
	 * (Re)arms the background sync timer. registerInterval would accumulate a
	 * new timer on every settings save, so the previous one is cleared first.
	 */
	rescheduleSync(): void {
		if (this.syncTimer !== null) {
			window.clearInterval(this.syncTimer);
			this.syncTimer = null;
		}
		const minutes = this.settings.caldav.intervalMinutes;
		const configured = this.settings.caldav.username && this.settings.caldav.password;
		if (!minutes || !configured) return;

		this.syncTimer = window.setInterval(
			() => {
				// Background passes stay quiet; only explicit syncs report.
				void this.sync.run(false);
			},
			minutes * 60_000
		);
		this.registerInterval(this.syncTimer);
	}

	/**
	 * Settings changes (filters, colours, horizon) are not vault changes, so
	 * the index will not fire -- push them to the open views directly.
	 */
	refreshViews(): void {
		for (const type of VIEW_TYPES) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				(leaf.view as RefreshableView).refresh?.();
			}
		}
	}
}
