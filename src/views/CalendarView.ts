import { ItemView, WorkspaceLeaf } from "obsidian";
import { Calendar, EventInput } from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import type TypedCalendarPlugin from "../../main";
import { CalendarEvent } from "../model/types";
import { TypeModal } from "./TypeModal";
import { indexTypes } from "../model/priority";
import { expandOccurrences } from "../model/recurrence";
import { addDays, startOfToday, toDateString } from "../util/dates";
import {
	CALENDAR_VIEW,
	colorFor,
	matchesFilters,
	renderFilterBar,
} from "./shared";

export class CalendarGridView extends ItemView {
	private calendar: Calendar | null = null;
	private filterEl!: HTMLElement;
	private gridEl!: HTMLElement;
	private unsubscribe: (() => void) | null = null;
	/**
	 * The span the grid is currently showing. Repeating events are expanded
	 * into this window rather than into some fixed range: a rule with no end
	 * date has infinitely many occurrences, so "what is on screen" is the only
	 * honest bound.
	 */
	private range: { from: string; to: string } | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: TypedCalendarPlugin) {
		super(leaf);
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

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("tc-view");
		this.filterEl = root.createDiv();
		this.gridEl = root.createDiv({ cls: "tc-calendar-grid" });

		this.calendar = new Calendar(this.gridEl, {
			plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin],
			initialView: "dayGridMonth",
			headerToolbar: {
				left: "prev,next today",
				center: "title",
				right: "dayGridMonth,timeGridWeek,listWeek",
			},
			height: "100%",
			navLinks: true,
			nowIndicator: true,
			// A month that needs five weeks should not draw six: the trailing row
			// of greyed-out days is pure noise.
			fixedWeekCount: false,
			dayMaxEventRows: 4,
			buttonText: { today: "Today", month: "Month", week: "Week", list: "Agenda" },
			dayHeaderFormat: { weekday: "short" },
			eventTimeFormat: { hour: "numeric", minute: "2-digit", meridiem: "short" },
			slotLabelFormat: { hour: "numeric", minute: "2-digit", meridiem: "short" },
			// The per-type colour is applied through a custom property rather than
			// FullCalendar's inline background, so the stylesheet can tint, outline
			// and hover it. An inline background-color would win over all of that.
			eventDidMount: (info) => {
				const color = String(info.event.extendedProps.color ?? "");
				if (color) info.el.style.setProperty("--tc-event-color", color);
			},
			datesSet: (info) => {
				const from = info.startStr.slice(0, 10);
				const to = info.endStr.slice(0, 10);
				// Fires on every render, including the one refresh() triggers;
				// re-rendering an unchanged range would loop.
				if (this.range?.from === from && this.range?.to === to) return;
				this.range = { from, to };
				this.refresh();
			},
			eventClick: (info) => {
				const event = this.plugin.index.byPath(String(info.event.extendedProps.path));
				if (!event) return;
				// Which occurrence was clicked matters: skipping a holiday acts
				// on that date, not on the series start.
				const occurrence = String(info.event.extendedProps.occurrence ?? "") || undefined;
				this.plugin.openEventModal(event, undefined, occurrence);
			},
			dateClick: (info) => {
				this.plugin.openEventModal(undefined, info.dateStr.slice(0, 10));
			},
		});
		this.calendar.render();

		this.unsubscribe = this.plugin.index.onChange(() => this.refresh());
		this.refresh();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		// FullCalendar attaches window listeners; leaking them would break the
		// next view that opens in this leaf.
		this.calendar?.destroy();
		this.calendar = null;
	}

	refresh(): void {
		this.renderFilters();
		if (!this.calendar) return;
		const typeMap = indexTypes(this.plugin.settings.eventTypes);
		const active = this.plugin.settings.activeFilters;

		const window = this.range ?? defaultRange();
		const inputs: EventInput[] = [];
		for (const event of this.plugin.index.scheduled()) {
			if (!matchesFilters(event, active)) continue;
			const color = colorFor(event, typeMap);
			for (const date of expandOccurrences(
				event.date as string,
				event.recurrence,
				event.exceptions ?? [],
				window
			)) {
				inputs.push(toEventInput(event, date, color));
			}
		}

		this.calendar.removeAllEvents();
		this.calendar.addEventSource(inputs);
	}

	private renderFilters(): void {
		this.filterEl.empty();
		renderFilterBar(
			this.filterEl,
			this.plugin.settings.eventTypes,
			this.plugin.settings.activeFilters,
			(id) => void this.plugin.toggleFilter(id),
			() => new TypeModal(this.app, this.plugin, () => this.refresh()).open()
		);
	}
}

/** Used before the grid has reported a range, e.g. on the very first render. */
function defaultRange(): { from: string; to: string } {
	const today = toDateString(startOfToday());
	return { from: addDays(today, -45), to: addDays(today, 45) };
}

function toEventInput(
	event: CalendarEvent,
	date: string,
	color: string | undefined
): EventInput {
	const input: EventInput = {
		// One note can draw many blocks, so the id has to name the occurrence.
		id: `${event.path}#${date}`,
		title: event.title,
		allDay: event.allDay,
		classNames: ["tc-event", event.allDay || !event.startTime ? "tc-event-allday" : "tc-event-timed"],
		extendedProps: { path: event.path, occurrence: date, color },
	};
	if (event.allDay || !event.startTime) {
		input.start = date;
	} else {
		input.start = `${date}T${event.startTime}`;
		// FullCalendar renders a zero-length event as a dot; give untimed-end
		// events a visible default block instead.
		input.end = event.endTime ? `${date}T${event.endTime}` : undefined;
	}
	return input;
}
