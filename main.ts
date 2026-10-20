import { Platform, Plugin, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { EventIndex } from "./src/index/EventIndex";
import { writeEventNote } from "./src/index/writer";
import { EventModal, EventPrefill } from "./src/views/EventModal";
import {
	CalendarEvent,
	OccurrenceOverride,
	PROVIDER_LABELS,
	ProviderKey,
	isPullOnlySeries,
} from "./src/model/types";
import { OAuthAccount, googleOAuth, outlookOAuth } from "./src/sync/account";
import { GoogleProvider } from "./src/sync/google/client";
import { OutlookProvider } from "./src/sync/outlook/client";
import { RemoteProvider } from "./src/sync/remote";
import { excludeLink } from "./src/sync/notes";
import { Occurrence, expandEvent, isOccurrenceOf, withOccurrenceDone } from "./src/model/occurrences";
import { SyncEngine } from "./src/sync/SyncEngine";
import { setFallbackTransport } from "./src/sync/http";
import { mobileRequest } from "./src/sync/mobileHttp";
import { writeAgentDocs } from "./src/agent/docs";
import { EventType, TypeField } from "./src/model/types";
import { generateUid } from "./src/model/serialize";
import { SyncDevice, isSyncDevice, newDeviceId, shouldClaim } from "./src/sync/device";
import {
	DEFAULT_SETTINGS,
	inEventFolders,
	TypedCalendarSettings,
	mergeTypeFields,
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
	/** The interval and credentials the running timer was armed with. */
	private syncTimerKey = "";
	/** Signature of the last docs write, so unrelated saves do not rewrite them. */
	private docsSignature = "";
	/**
	 * The docs rewrite after a settings save, batched: renaming a custom field
	 * saves on every key, and each save would otherwise rewrite four files.
	 */
	private readonly scheduleAgentDocs = debounce(() => void this.refreshAgentDocs(), 1000, true);

	/**
	 * Optional scripted surface for agents and Templater. Writing event notes
	 * directly is the supported path; this is a convenience on top.
	 *
	 * Other plugins build on it too, so `version` goes up only when an existing
	 * entry changes shape; adding an entry does not bump it.
	 */
	readonly api = {
		version: 1,
		/** Calls `listener` whenever the event index changes. Returns an unsubscribe. */
		onChange: (listener: () => void): (() => void) => this.index.onChange(listener),
		/** The folder new event notes are written to. */
		eventFolder: (): string => this.settings.eventFolder,
		/** Every folder event notes are read (and synced) from, the main one first. */
		eventFolders: (): string[] => [this.settings.eventFolder, ...this.settings.extraEventFolders],
		/**
		 * Also read and sync event notes from `folder`. Kept in settings, so it
		 * survives the caller being disabled; the user can remove it there.
		 */
		addEventFolder: (folder: string) => this.addEventFolder(folder),
		listEvents: (): CalendarEvent[] => this.index.all(),
		listScheduled: (): CalendarEvent[] => this.index.scheduled(),
		listUnscheduled: (): CalendarEvent[] => this.index.unscheduled(),
		createType: (label: string, color = "#888888", rank = 10) =>
			this.createType(label, color, rank),
		listTypes: (): EventType[] => this.settings.eventTypes,
		/**
		 * Declares fields on a type so they show in the event editor. Only
		 * missing keys are added; an existing field is never changed.
		 */
		addTypeFields: (typeId: string, fields: TypeField[]) => this.addTypeFields(typeId, fields),
		/**
		 * `folder`, when given, must be one of eventFolders() or inside one, so
		 * the new note is indexed and synced like any other.
		 */
		createEvent: (event: Partial<CalendarEvent> & { folder?: string }) =>
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
					done: event.done ? true : undefined,
					path: "",
				},
				true,
				this.creationFolder(event.folder)
			),
		updateEvent: (event: CalendarEvent) => this.writeEvent(event, false),
		/**
		 * Crosses an event off, or back on. A done event stays in the vault and
		 * in sync, marked as done; the views hide it unless Show completed is on.
		 */
		setDone: (uid: string, done: boolean) => this.setDone(uid, done),
		/** Crosses off one occurrence of a repeating event (`occurrence` is the date the rule gives it). */
		setOccurrenceDone: (uid: string, occurrence: string, done: boolean) =>
			this.setOccurrenceDone(uid, occurrence, done),
		/**
		 * The occurrences of an event within [from, to] (YYYY-MM-DD), with any
		 * per-occurrence change and done state applied. A one-off event gives
		 * itself when its date is in range.
		 */
		listOccurrences: (uid: string, from: string, to: string): Occurrence[] => {
			const event = this.index.byUid(uid);
			if (!event) throw new Error(`No event with uid ${uid}.`);
			return expandEvent(event, { from, to });
		},
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
		/**
		 * Changes one occurrence of a repeating event -- moves it, retimes it,
		 * gives it another room -- leaving the rest of the series alone.
		 * `date` is the date the rule puts it on, not where it is moving to.
		 */
		changeOccurrence: (
			uid: string,
			date: string,
			changes: Omit<OccurrenceOverride, "occurrence">
		) => this.setOccurrenceOverride(uid, { ...changes, occurrence: date }),
		/** Puts a changed occurrence back in line with its series. */
		resetOccurrence: (uid: string, date: string) =>
			this.setOccurrenceOverride(uid, { occurrence: date }, true),
		/** Opens the event editor, on one occurrence when `occurrence` is given. */
		openEvent: (uid: string, occurrence?: string) => {
			const event = this.index.byUid(uid);
			if (!event) throw new Error(`No event with uid ${uid}.`);
			this.openEventModal(event, undefined, occurrence);
		},
		sync: () => this.sync.run(),
	};

	async onload(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
		// No Node on iPad and iPhone; see sync/mobileHttp.ts.
		if (Platform.isMobileApp) setFallbackTransport(mobileRequest);

		this.index = new EventIndex(this.app, this.settings.eventFolder, this.settings.extraEventFolders);
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
	async writeEvent(event: CalendarEvent, isNew: boolean, folder = this.settings.eventFolder): Promise<TFile> {
		return writeEventNote(this.app, folder, event, isNew);
	}

	/** Where a new event goes: the main folder, or a caller's folder inside an event folder. */
	private creationFolder(folder: string | undefined): string {
		if (folder === undefined) return this.settings.eventFolder;
		const clean = folder.replace(/^\/+|\/+$/g, "");
		const roots = [this.settings.eventFolder, ...this.settings.extraEventFolders];
		if (!inEventFolders(`${clean}/x.md`, roots)) {
			throw new Error(`${clean || "The vault root"} is not in an event folder, so a note there would be neither shown nor synced.`);
		}
		return clean;
	}

	async addEventFolder(folder: string): Promise<void> {
		const clean = folder.trim().replace(/^\/+|\/+$/g, "");
		if (!clean) throw new Error("addEventFolder needs a folder; the whole vault is set with the event folder setting.");
		if (clean === this.settings.eventFolder || this.settings.extraEventFolders.includes(clean)) return;
		this.settings.extraEventFolders = [...this.settings.extraEventFolders, clean];
		await this.saveSettings();
	}

	/** This computer's id, kept in Obsidian's per-device storage; made on first use. */
	deviceId(): string {
		const key = "typed-calendar-device-id";
		const app = this.app as unknown as {
			loadLocalStorage?: (key: string) => unknown;
			saveLocalStorage?: (key: string, value: unknown) => void;
		};
		// loadLocalStorage (Obsidian 1.8.7+) is scoped to this vault; older
		// builds get the same scoping by hand.
		const fallbackKey = `${key}:${this.app.vault.getName()}`;
		const stored = app.loadLocalStorage ? app.loadLocalStorage(key) : window.localStorage.getItem(fallbackKey);
		if (typeof stored === "string" && stored) return stored;
		const id = newDeviceId();
		if (app.saveLocalStorage) app.saveLocalStorage(key, id);
		else window.localStorage.setItem(fallbackKey, id);
		return id;
	}

	/** This computer, as the settings record it. */
	thisDevice(): SyncDevice {
		let name = "this computer";
		try {
			// Only computers get here (see isSyncDevice), and they have Node's os module.
			name = (require("os") as { hostname(): string }).hostname() || name;
		} catch {
			// Keep the generic name.
		}
		return { id: this.deviceId(), name };
	}

	/**
	 * Whether this computer is the one that syncs. Reads the settings file
	 * fresh: when another computer takes over, its choice arrives in the file
	 * through the vault sync, and this plugin's in-memory copy would not know.
	 *
	 * Never an iPad or iPhone: CalDAV discovery needs Node's http (sync/http.ts).
	 */
	async isSyncDevice(): Promise<boolean> {
		if (Platform.isMobileApp) return false;
		const stored = normalizeSettings(await this.loadData());
		return isSyncDevice(stored.syncDevice ?? this.settings.syncDevice, this.deviceId());
	}

	/** Makes this computer the one that syncs (on), or no computer at all (off). */
	async setSyncOnThisDevice(on: boolean): Promise<void> {
		this.settings.syncDevice = on ? this.thisDevice() : { id: "", name: "" };
		await this.saveSettings();
	}

	async setDone(uid: string, done: boolean): Promise<TFile> {
		const event = this.index.byUid(uid);
		if (!event) throw new Error(`No event with uid ${uid}.`);
		if (event.readOnly) throw new Error(`"${event.title}" is locked (readOnly in its note).`);
		if (Boolean(event.done) === done) return this.fileFor(event);
		return this.writeEvent({ ...event, done: done ? true : undefined }, false);
	}

	async setOccurrenceDone(uid: string, occurrence: string, done: boolean): Promise<TFile> {
		const event = this.index.byUid(uid);
		if (!event) throw new Error(`No event with uid ${uid}.`);
		if (event.readOnly) throw new Error(`"${event.title}" is locked (readOnly in its note).`);
		if (!event.recurrence) throw new Error(`"${event.title}" does not repeat; cross the event itself off.`);
		if (!isOccurrenceOf(event, occurrence)) throw new Error(`"${event.title}" has no occurrence on ${occurrence}.`);
		return this.writeEvent({ ...event, overrides: withOccurrenceDone(event.overrides, occurrence, done) }, false);
	}

	private fileFor(event: CalendarEvent): TFile {
		const file = this.app.vault.getAbstractFileByPath(event.path);
		if (!(file instanceof TFile)) throw new Error(`Event note not found: ${event.path}`);
		return file;
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
		// A skipped occurrence has nothing left to change, and an override kept
		// behind the exclusion would resurface as a surprise on restoring it.
		const overrides = skipped
			? event.overrides?.filter((override) => override.occurrence !== date)
			: event.overrides;
		return this.writeEvent(
			{
				...event,
				exceptions: dates.size > 0 ? Array.from(dates).sort() : undefined,
				overrides: overrides?.length ? overrides : undefined,
			},
			false
		);
	}

	/**
	 * Sets or clears the change on one occurrence of a repeating event. Syncs
	 * out as a RECURRENCE-ID component, so the phone shows the same week.
	 *
	 * `reset` removes the override entirely, including anything the server
	 * held on that occurrence that the note does not model.
	 */
	async setOccurrenceOverride(
		uid: string,
		override: OccurrenceOverride,
		reset = false
	): Promise<TFile> {
		const event = this.index.byUid(uid);
		if (!event) throw new Error(`No event with uid ${uid}.`);
		if (!event.recurrence) throw new Error(`"${event.title}" does not repeat.`);
		if (!isOccurrenceOf(event, override.occurrence)) {
			throw new Error(`"${event.title}" does not happen on ${override.occurrence}.`);
		}

		const others = (event.overrides ?? []).filter(
			(existing) => existing.occurrence !== override.occurrence
		);
		const overrides = reset ? others : [...others, override];
		return this.writeEvent(
			{ ...event, overrides: overrides.length > 0 ? overrides : undefined },
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
				`"${event.title}" repeats in a way this plugin cannot author, so it will not delete it. Remove it in the calendar app it came from instead.`
			);
		}
		if (event.readOnly) {
			throw new Error(
				`"${event.title}" is locked (readOnly in its note), so it will not be deleted. Remove that line first if you really mean to.`
			);
		}
		await this.deleteEverywhere(event);
	}

	/**
	 * Removes an event from every service it is linked to, then trashes the
	 * note. `skip` is a service it is already gone from.
	 *
	 * Each service's copy goes before the note, and on purpose: a note deleted
	 * while a copy still exists is not a deletion at all, because the next pull
	 * finds the copy with no note and downloads it straight back. If any service
	 * refuses, the note is kept -- and the services it did leave are marked so
	 * nothing sends it back there -- and the error says which one.
	 */
	async deleteEverywhere(event: CalendarEvent, skip?: ProviderKey): Promise<void> {
		const failures: string[] = [];
		const removed: ProviderKey[] = [];
		for (const key of ["icloud", "google", "outlook"] as const) {
			const link = event[key];
			if (key === skip || !link?.href) continue;
			try {
				if (key === "icloud") await this.sync.client().delete(link.href, link.etag);
				else await this.provider(key).delete(link.collection ?? "", link.href);
				removed.push(key);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`${PROVIDER_LABELS[key]}: ${message}`);
			}
		}
		if (failures.length > 0) {
			for (const key of removed) await excludeLink(this.app, event, key);
			throw new Error(`Could not remove "${event.title}" everywhere. ${failures.join("; ")}`);
		}

		const file = this.app.vault.getAbstractFileByPath(event.path);
		if (file) await this.app.fileManager.trashFile(file);
	}

	/**
	 * The signed-in account for Google or Outlook. Tokens are read from and
	 * saved to settings; a refresh is saved quietly, without redrawing views.
	 */
	account(key: "google" | "outlook"): OAuthAccount {
		const service = this.settings[key];
		const config =
			key === "google" ? googleOAuth(service.clientId, service.clientSecret) : outlookOAuth(service.clientId);
		return new OAuthAccount(
			config,
			() => this.settings[key].tokens,
			async (tokens) => {
				this.settings[key].tokens = tokens;
				await this.saveData(this.settings);
			}
		);
	}

	provider(key: "google" | "outlook"): RemoteProvider {
		return key === "google"
			? new GoogleProvider(this.account("google"))
			: new OutlookProvider(this.account("outlook"));
	}

	/** Google and Outlook, when signed in with at least one calendar enabled. */
	remoteProviders(): RemoteProvider[] {
		return (["google", "outlook"] as const)
			.filter((key) => this.settings[key].tokens && this.settings[key].calendars.some((c) => c.enabled))
			.map((key) => this.provider(key));
	}

	openEventModal(existing?: CalendarEvent, prefill?: EventPrefill, occurrence?: string): void {
		new EventModal(this.app, this, existing, prefill, occurrence).open();
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

	/** Adds the fields a type is missing; see mergeTypeFields. */
	async addTypeFields(typeId: string, fields: TypeField[]): Promise<EventType> {
		const index = this.settings.eventTypes.findIndex((type) => type.id === typeId);
		if (index < 0) throw new Error(`No event type with id ${typeId}.`);
		const current = this.settings.eventTypes[index];
		const merged = mergeTypeFields(current, fields);
		if (merged === current) return current;
		this.settings.eventTypes[index] = merged;
		await this.saveSettings();
		// Same as createType: the docs list every field.
		void this.refreshAgentDocs();
		return merged;
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

	/**
	 * The settings file changed on disk: a vault sync brought another
	 * computer's version. Take it as it is. Saving the old in-memory copy
	 * later would otherwise write stale settings back over it -- a laptop that
	 * started before the desktop's settings arrived would wipe them.
	 */
	async onExternalSettingsChange(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
		this.index.setFolders(this.settings.eventFolder, this.settings.extraEventFolders);
		this.rescheduleSync();
		this.refreshViews();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.index.setFolders(this.settings.eventFolder, this.settings.extraEventFolders);
		this.rescheduleSync();
		this.scheduleAgentDocs();
		this.refreshViews();
	}

	onunload(): void {
		this.scheduleAgentDocs.cancel();
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
		const minutes = this.settings.caldav.intervalMinutes;
		const { caldav, google, outlook } = this.settings;
		// Any connected service is enough for the timer to be worth running.
		const configured = Boolean(
			(caldav.username && caldav.password) || google.tokens || outlook.tokens
		);
		// The first computer to have a service connected becomes the one that
		// syncs; see sync/device.ts. The save lands back here with the same key,
		// so this does not loop. A phone or tablet never takes it.
		if (!Platform.isMobileApp && shouldClaim(this.settings.syncDevice, configured)) {
			this.settings.syncDevice = this.thisDevice();
			void this.saveSettings();
		}
		// Every settings save lands here -- toggling a type filter, the stamp a
		// sync writes when it finishes. Restarting the countdown each time would
		// keep postponing the next background sync, so only a change to the
		// timer's own inputs does.
		const key = `${minutes}|${configured}`;
		if (key === this.syncTimerKey) return;
		this.syncTimerKey = key;

		if (this.syncTimer !== null) {
			window.clearInterval(this.syncTimer);
			this.syncTimer = null;
		}
		if (!minutes || !configured || Platform.isMobileApp) return;

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
