import { ItemView, Notice, Scope, ViewStateResult, WorkspaceLeaf } from "obsidian";
import {
	Calendar,
	CustomButtonInput,
	DateSelectArg,
	EventApi,
	EventInput,
	EventSourceApi,
} from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import multiMonthPlugin from "@fullcalendar/multimonth";
import interactionPlugin from "@fullcalendar/interaction";
import type TypedCalendarPlugin from "../../main";
import { CalendarEvent, isLocked } from "../model/types";
import { TypeModal } from "./TypeModal";
import { JumpModal } from "./JumpModal";
import { annotationsFor, indexTypes } from "../model/priority";
import { describeRecurrence } from "../model/recurrence";
import { Occurrence, applyOverride, buildOverride, expandEvent } from "../model/occurrences";
import { addDays, startOfToday, toDateString } from "../util/dates";
import {
	CALENDAR_VIEW,
	EXPECTING_VIEW,
	colorFor,
	matchesFilters,
	renderFilterBar,
} from "./shared";

/** The views the switcher offers, and the only ones a saved state may name. */
const VIEWS = ["multiMonthYear", "dayGridMonth", "timeGridWeek", "timeGridDay", "listWeek"] as const;
type ViewName = (typeof VIEWS)[number];

/** What the workspace remembers between sessions: where the user was. */
interface CalendarState {
	view?: ViewName;
	date?: string;
}

/** How long the pointer rests on an event before its preview appears. */
const PREVIEW_DELAY_MS = 350;

export class CalendarGridView extends ItemView {
	private calendar: Calendar | null = null;
	/**
	 * The one event source the grid draws from, replaced on each refresh.
	 * removeAllEvents() empties sources but keeps them registered, so adding a
	 * new source per refresh left one more behind every time.
	 */
	private source: EventSourceApi | null = null;
	private gridEl!: HTMLElement;
	private unsubscribe: (() => void) | null = null;
	/**
	 * The span the grid is currently showing. Repeating events are expanded
	 * into this window rather than into some fixed range: a rule with no end
	 * date has infinitely many occurrences, so "what is on screen" is the only
	 * honest bound.
	 */
	private range: { from: string; to: string } | null = null;
	/** State handed over before the grid existed, applied once it does. */
	private pending: CalendarState | null = null;
	private typesPopover: HTMLElement | null = null;
	private closeTypesOnOutsideClick: ((evt: MouseEvent) => void) | null = null;
	private preview: HTMLElement | null = null;
	private previewTimer: number | null = null;
	/** Toolbar labels as last rendered, so they are only re-rendered on change. */
	private buttonLabels = "";

	constructor(leaf: WorkspaceLeaf, private plugin: TypedCalendarPlugin) {
		super(leaf);
		// Shortcuts apply while the calendar is the active view, and never
		// while a modal or a text field has the keyboard.
		this.scope = new Scope(this.app.scope);
		const key = (k: string, run: () => void) =>
			this.scope!.register([], k, () => {
				run();
				return false;
			});
		key("ArrowLeft", () => this.calendar?.prev());
		key("ArrowRight", () => this.calendar?.next());
		key("t", () => this.calendar?.today());
		key("n", () => this.newEvent());
		key("g", () => this.openJump());
		key("y", () => this.calendar?.changeView("multiMonthYear"));
		key("m", () => this.calendar?.changeView("dayGridMonth"));
		key("w", () => this.calendar?.changeView("timeGridWeek"));
		key("d", () => this.calendar?.changeView("timeGridDay"));
		key("a", () => this.calendar?.changeView("listWeek"));
	}

	getViewType(): string {
		return CALENDAR_VIEW;
	}

	getDisplayText(): string {
		return "Calendar";
	}

	getIcon(): string {
		return "calendar-days";
	}

	getState(): Record<string, unknown> {
		const state = super.getState();
		if (this.calendar) {
			state.view = this.calendar.view.type;
			state.date = toDateString(this.calendar.getDate());
		} else if (this.pending) {
			Object.assign(state, this.pending);
		}
		return state;
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const raw = (state ?? {}) as Record<string, unknown>;
		const next: CalendarState = {};
		if (VIEWS.includes(raw.view as ViewName)) next.view = raw.view as ViewName;
		if (typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) next.date = raw.date;
		if (this.calendar) this.applyState(next);
		else this.pending = next;
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("tc-view");
		this.gridEl = root.createDiv({ cls: "tc-calendar-grid" });

		const start = this.pending;
		this.pending = null;

		this.calendar = new Calendar(this.gridEl, {
			plugins: [dayGridPlugin, timeGridPlugin, listPlugin, multiMonthPlugin, interactionPlugin],
			initialView: start?.view ?? "dayGridMonth",
			initialDate: start?.date,
			headerToolbar: {
				left: "prev,next today",
				center: "title",
				right: "tcAwaiting tcTypes tcNew multiMonthYear,dayGridMonth,timeGridWeek,timeGridDay,listWeek",
			},
			customButtons: this.customButtons(),
			height: "100%",
			navLinks: true,
			nowIndicator: true,
			// A month that needs five weeks should not draw six: the trailing row
			// of greyed-out days is pure noise.
			fixedWeekCount: false,
			dayMaxEventRows: 4,
			buttonText: {
				today: "Today", year: "Year", month: "Month", week: "Week", day: "Day", list: "Agenda",
			},
			buttonHints: {
				prev: "Previous (←)", next: "Next (→)", today: "Today (T)",
			},
			views: {
				// Twelve small months, for moving across a year at a glance. Events
				// are drawn as thin coloured bars (see styles.css), so a busy day
				// reads as busy without any text to truncate; hover for details.
				multiMonthYear: {
					multiMonthMaxColumns: 4,
					multiMonthMinWidth: 200,
					dayMaxEventRows: 4,
					eventDisplay: "block",
				},
			},
			dayHeaderFormat: { weekday: "short" },
			eventTimeFormat: { hour: "numeric", minute: "2-digit", meridiem: "short" },
			slotLabelFormat: { hour: "numeric", minute: "2-digit", meridiem: "short" },

			// --- drag to reschedule ---
			editable: true,
			snapDuration: "00:15:00",
			eventDrop: (info) => void this.applyDrag(info.event, info.revert),
			eventResize: (info) => void this.applyDrag(info.event, info.revert),
			eventDragStart: () => this.hidePreview(),
			eventResizeStart: () => this.hidePreview(),

			// --- click or drag on empty space to create ---
			selectable: true,
			selectMirror: true,
			select: (info) => this.onSelect(info),

			// The per-type colour is applied through a custom property rather than
			// FullCalendar's inline background, so the stylesheet can tint, outline
			// and hover it. An inline background-color would win over all of that.
			eventDidMount: (info) => {
				const color = String(info.event.extendedProps.color ?? "");
				if (color) info.el.style.setProperty("--tc-event-color", color);
			},
			eventMouseEnter: (info) => this.schedulePreview(info.event, info.el),
			eventMouseLeave: () => this.hidePreview(),
			datesSet: (info) => {
				this.hidePreview();
				this.markTitle();
				// Remembered across restarts through the workspace layout.
				this.app.workspace.requestSaveLayout();
				const from = info.startStr.slice(0, 10);
				const to = info.endStr.slice(0, 10);
				// Fires on every render, including the one refresh() triggers;
				// re-rendering an unchanged range would loop.
				if (this.range?.from === from && this.range?.to === to) return;
				this.range = { from, to };
				this.refresh();
			},
			eventClick: (info) => {
				this.hidePreview();
				const event = this.plugin.index.byPath(String(info.event.extendedProps.path));
				if (!event) return;
				// Which occurrence was clicked matters: skipping a holiday acts
				// on that date, not on the series start.
				const occurrence = String(info.event.extendedProps.occurrence ?? "") || undefined;
				this.plugin.openEventModal(event, undefined, occurrence);
			},
		});
		this.calendar.render();

		// The title is FullCalendar's, re-rendered on every navigation, so its
		// click is caught here rather than bound to the element.
		this.registerDomEvent(this.gridEl, "click", (evt) => {
			if ((evt.target as HTMLElement).closest(".fc-toolbar-title")) this.openJump();
		});

		// No refresh here: render() above already fired datesSet, which drew
		// the events for the first range.
		this.unsubscribe = this.plugin.index.onChange(() => this.refresh());
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.closeTypes();
		this.hidePreview();
		// FullCalendar attaches window listeners; leaking them would break the
		// next view that opens in this leaf.
		this.calendar?.destroy();
		this.calendar = null;
		this.source = null;
	}

	refresh(): void {
		if (!this.calendar) return;
		this.updateToolbar();
		if (this.typesPopover) this.renderTypesPanel(this.typesPopover);

		const typeMap = indexTypes(this.plugin.settings.eventTypes);
		const active = this.plugin.settings.activeFilters;
		const window = this.range ?? defaultRange();
		const inputs: EventInput[] = [];
		for (const event of this.plugin.index.scheduled()) {
			if (!matchesFilters(event, active)) continue;
			const color = colorFor(event, typeMap);
			for (const instance of expandEvent(event, window)) {
				inputs.push(toEventInput(event, instance, color));
			}
		}

		// One re-render for the swap, not one for the removal and another for
		// the addition.
		const calendar = this.calendar;
		calendar.batchRendering(() => {
			this.source?.remove();
			this.source = calendar.addEventSource(inputs);
		});
	}

	private applyState(state: CalendarState): void {
		if (!this.calendar) return;
		if (state.view && state.view !== this.calendar.view.type) {
			this.calendar.changeView(state.view, state.date);
		} else if (state.date) {
			this.calendar.gotoDate(state.date);
		}
	}

	// --- toolbar -------------------------------------------------------------

	private customButtons(): Record<string, CustomButtonInput> {
		return {
			tcNew: {
				text: "+ New event",
				hint: "New event (N)",
				click: () => this.newEvent(),
			},
			tcTypes: {
				text: this.typesLabel(),
				hint: "Choose which types to show",
				click: (_evt, el) => this.toggleTypes(el),
			},
			tcAwaiting: {
				text: this.awaitingLabel(),
				hint: "Events with no date yet -- open Expecting soon",
				click: () => void this.plugin.activateView(EXPECTING_VIEW, "right"),
			},
		};
	}

	private typesLabel(): string {
		const count = this.plugin.settings.activeFilters.length;
		return count > 0 ? `Types · ${count}` : "Types";
	}

	private awaitingLabel(count = this.plugin.index.unscheduled().length): string {
		return `${count} awaiting date${count === 1 ? "" : "s"}`;
	}

	/**
	 * Re-renders the toolbar only when a label actually changed: setOption
	 * rebuilds the whole toolbar, which would otherwise happen on every
	 * vault change.
	 */
	private updateToolbar(): void {
		if (!this.calendar) return;
		const awaiting = this.plugin.index.unscheduled().length;
		const labels = `${this.typesLabel()}|${this.awaitingLabel(awaiting)}`;
		// Hidden rather than shown as "0 awaiting dates": nothing to act on.
		this.gridEl.toggleClass("tc-no-awaiting", awaiting === 0);
		this.gridEl.toggleClass("tc-filtered", this.plugin.settings.activeFilters.length > 0);
		if (labels === this.buttonLabels) return;
		this.buttonLabels = labels;
		this.calendar.setOption("customButtons", this.customButtons());
		this.markTitle();
	}

	/** Makes the title announce that it opens the date picker. */
	private markTitle(): void {
		const title = this.gridEl.querySelector(".fc-toolbar-title");
		title?.setAttr("title", "Go to a month or year (G)");
		title?.setAttr("role", "button");
	}

	private openJump(): void {
		if (!this.calendar) return;
		new JumpModal(this.app, toDateString(this.calendar.getDate()), (date) => {
			// Picking a month from the year overview means "show me that month".
			if (this.calendar?.view.type === "multiMonthYear") {
				this.calendar.changeView("dayGridMonth", date);
			} else {
				this.calendar?.gotoDate(date);
			}
		}).open();
	}

	/**
	 * A new event on the day in view: today when today is on screen, else the
	 * first day of what is showing -- so browsing to next March and pressing
	 * New starts in March.
	 */
	private newEvent(): void {
		const today = toDateString(startOfToday());
		const range = this.range;
		const date = !range || (today >= range.from && today < range.to)
			? today
			: toDateString(this.calendar?.getDate() ?? startOfToday());
		this.plugin.openEventModal(undefined, { date, allDay: true });
	}

	// --- types filter ----------------------------------------------------------

	private toggleTypes(anchor: HTMLElement): void {
		if (this.typesPopover) {
			this.closeTypes();
			return;
		}
		const root = this.contentEl;
		const popover = root.createDiv({ cls: "tc-types-popover" });
		const bounds = root.getBoundingClientRect();
		const button = anchor.getBoundingClientRect();
		popover.style.top = `${button.bottom - bounds.top + 6}px`;
		popover.style.right = `${Math.max(8, bounds.right - button.right)}px`;
		this.typesPopover = popover;
		this.renderTypesPanel(popover);

		// Deferred, so the click that opened it does not immediately close it.
		window.setTimeout(() => {
			this.closeTypesOnOutsideClick = (evt: MouseEvent) => {
				const target = evt.target as HTMLElement;
				if (popover.contains(target) || target.closest(".fc-tcTypes-button")) return;
				this.closeTypes();
			};
			document.addEventListener("mousedown", this.closeTypesOnOutsideClick);
		});
	}

	private renderTypesPanel(popover: HTMLElement): void {
		popover.empty();
		popover.createDiv({ cls: "tc-types-popover-title", text: "Show types" });
		renderFilterBar(
			popover,
			this.plugin.settings.eventTypes,
			this.plugin.settings.activeFilters,
			(id) => void this.plugin.toggleFilter(id),
			() => {
				this.closeTypes();
				new TypeModal(this.app, this.plugin, () => this.refresh()).open();
			}
		);
		popover.createDiv({
			cls: "tc-types-popover-hint",
			text:
				this.plugin.settings.activeFilters.length > 0
					? "Showing events of any selected type."
					: "Nothing selected shows every type.",
		});
	}

	private closeTypes(): void {
		if (this.closeTypesOnOutsideClick) {
			document.removeEventListener("mousedown", this.closeTypesOnOutsideClick);
			this.closeTypesOnOutsideClick = null;
		}
		this.typesPopover?.remove();
		this.typesPopover = null;
	}

	// --- create by clicking or dragging ------------------------------------------

	private onSelect(info: DateSelectArg): void {
		this.calendar?.unselect();
		// In the year overview a click is for getting somewhere, not for
		// creating: open that month.
		if (info.view.type === "multiMonthYear") {
			this.calendar?.changeView("dayGridMonth", info.start);
			return;
		}
		const date = toDateString(info.start);
		if (info.allDay) {
			this.plugin.openEventModal(undefined, { date, allDay: true });
			return;
		}
		// A plain click selects one slot; an hour is a better guess at what a
		// new event needs than half of one.
		const clicked = info.end.valueOf() - info.start.valueOf() <= 30 * 60_000;
		const end = clicked ? new Date(info.start.valueOf() + 60 * 60_000) : info.end;
		this.plugin.openEventModal(undefined, {
			date,
			allDay: false,
			startTime: clockTime(info.start),
			endTime: clockTime(end),
		});
	}

	// --- drag to reschedule -------------------------------------------------------

	/**
	 * Saves where an event was dragged or resized to. On a repeating event
	 * this moves only the occurrence that was dragged -- a lecture moved for
	 * one week -- and says so, since the rest of the series stays put.
	 */
	private async applyDrag(api: EventApi, revert: () => void): Promise<void> {
		const event = this.plugin.index.byPath(String(api.extendedProps.path));
		const occurrence = String(api.extendedProps.occurrence ?? "");
		if (!event || !api.start || isLocked(event)) {
			revert();
			return;
		}
		const allDay = api.allDay;
		const change = {
			date: toDateString(api.start),
			allDay,
			startTime: allDay ? undefined : clockTime(api.start),
			endTime: allDay || !api.end ? undefined : clockTime(api.end),
		};

		try {
			if (event.recurrence) {
				const existing = event.overrides?.find((o) => o.occurrence === occurrence);
				const override = buildOverride(event, occurrence, change, existing);
				if (override) {
					await this.plugin.setOccurrenceOverride(event.uid, override);
					new Notice(`Moved this occurrence of "${event.title}" only. The rest of the series is unchanged.`);
				}
			} else {
				await this.plugin.writeEvent({ ...event, ...change }, false);
			}
		} catch (error) {
			revert();
			console.error("Typed Calendar: could not move event", error);
			new Notice(`Could not move "${event.title}": ${(error as Error).message}`);
		}
	}

	// --- hover preview -------------------------------------------------------------

	private schedulePreview(api: EventApi, el: HTMLElement): void {
		this.hidePreview();
		this.previewTimer = window.setTimeout(() => this.showPreview(api, el), PREVIEW_DELAY_MS);
	}

	private showPreview(api: EventApi, el: HTMLElement): void {
		const event = this.plugin.index.byPath(String(api.extendedProps.path));
		if (!event || !el.isConnected) return;
		const occurrence = String(api.extendedProps.occurrence ?? event.date ?? "");
		const override = event.overrides?.find((o) => o.occurrence === occurrence);
		const instance = applyOverride(event, occurrence, event.recurrence ? override : undefined);
		const typeMap = indexTypes(this.plugin.settings.eventTypes);

		const card = document.body.createDiv({ cls: "tc-hover-card" });
		const color = colorFor(event, typeMap);
		if (color) card.style.setProperty("--tc-event-color", color);

		card.createDiv({ cls: "tc-hover-title", text: instance.title });
		card.createDiv({ cls: "tc-hover-when", text: describeWhen(instance) });

		if (event.types.length > 0) {
			const badges = card.createDiv({ cls: "tc-hover-types" });
			for (const id of event.types) {
				const type = typeMap.get(id);
				const badge = badges.createSpan({ cls: "tc-badge", text: type?.label ?? id });
				if (type) badge.style.setProperty("--tc-chip-color", type.color);
			}
		}

		// The fields each type marked as worth seeing at a glance, with the
		// occurrence's own room when it moved.
		const details = annotationsFor({ ...event, location: instance.location }, typeMap);
		if (details.length > 0) card.createDiv({ cls: "tc-hover-details", text: details.join(" · ") });

		const notes: string[] = [];
		if (event.recurrence) notes.push(describeRecurrence(event.recurrence));
		if (instance.override) notes.push("This occurrence was changed on its own");
		if (isLocked(event)) notes.push("Locked -- not editable here");
		for (const note of notes) card.createDiv({ cls: "tc-hover-note", text: note });

		// Below the event when there is room, above it when there is not.
		const rect = el.getBoundingClientRect();
		const cardRect = card.getBoundingClientRect();
		const below = rect.bottom + 6 + cardRect.height < window.innerHeight;
		const left = Math.min(Math.max(8, rect.left), window.innerWidth - cardRect.width - 8);
		card.style.left = `${left}px`;
		card.style.top = `${below ? rect.bottom + 6 : rect.top - cardRect.height - 6}px`;
		this.preview = card;
	}

	private hidePreview(): void {
		if (this.previewTimer !== null) {
			window.clearTimeout(this.previewTimer);
			this.previewTimer = null;
		}
		this.preview?.remove();
		this.preview = null;
	}
}

/** Used before the grid has reported a range, e.g. on the very first render. */
function defaultRange(): { from: string; to: string } {
	const today = toDateString(startOfToday());
	return { from: addDays(today, -45), to: addDays(today, 45) };
}

/** "14:05" from a Date, in local time -- the clock the grid is drawn on. */
function clockTime(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "Tue, Oct 13 · 2:00pm–3:00pm", or "· All day". */
function describeWhen(instance: Occurrence): string {
	const day = new Date(`${instance.date}T12:00:00`).toLocaleDateString(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
	});
	if (instance.allDay) return `${day} · All day`;
	const end = instance.endTime ? `–${gridTime(instance.date, instance.endTime)}` : "";
	return `${day} · ${gridTime(instance.date, instance.startTime as string)}${end}`;
}

/** A time the way the grid prints it ("2:00pm"), so the two never disagree. */
function gridTime(date: string, time: string): string {
	return new Date(`${date}T${time}:00`)
		.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
		.replace(" ", "")
		.toLowerCase();
}

function toEventInput(
	event: CalendarEvent,
	instance: Occurrence,
	color: string | undefined
): EventInput {
	const { date } = instance;
	const classNames = ["tc-event", instance.allDay ? "tc-event-allday" : "tc-event-timed"];
	if (instance.override) classNames.push("tc-event-changed");
	const locked = isLocked(event);
	if (locked) classNames.push("tc-event-locked");
	const input: EventInput = {
		// One note can draw many blocks, so the id has to name the occurrence --
		// by the date the rule gave it, which a move does not change.
		id: `${event.path}#${instance.occurrence}`,
		title: instance.title,
		allDay: instance.allDay,
		classNames,
		// A locked event, or a series the plugin cannot express, cannot be
		// dragged: the drop would have nowhere safe to go.
		editable: !locked,
		extendedProps: { path: event.path, occurrence: instance.occurrence, color },
	};
	if (instance.allDay) {
		input.start = date;
	} else {
		input.start = `${date}T${instance.startTime}`;
		// FullCalendar renders a zero-length event as a dot; give untimed-end
		// events a visible default block instead.
		input.end = instance.endTime ? `${date}T${instance.endTime}` : undefined;
	}
	return input;
}
