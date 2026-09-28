import { Setting } from "obsidian";
import {
	PRESET_DURATIONS,
	durationMinutes,
	formatClock,
	formatDuration,
	fromMinutes,
	parseClock,
	toMinutes,
} from "../util/clock";

/** Every quarter hour, which is as fine as anyone schedules by hand. */
const STEP_MINUTES = 15;
/** Where an empty start-time list opens. Nobody's event starts at 8:08 pm. */
const DEFAULT_START = "12:00";

/**
 * A popup list anchored under a field. Attached to the document body rather
 * than inside the modal, so a long list is never clipped by the modal's own
 * scrolling, and closed on an outside click, Escape, or scrolling away.
 */
class Popup {
	readonly el: HTMLElement;
	private readonly onOutside: (evt: MouseEvent) => void;
	private readonly onScroll: (evt: Event) => void;

	constructor(private anchor: HTMLElement, private onClose: () => void) {
		this.el = document.body.createDiv({ cls: "tc-time-popup" });
		this.onOutside = (evt) => {
			const target = evt.target as Node;
			if (!this.el.contains(target) && !this.anchor.contains(target)) this.close();
		};
		// The popup is fixed-position, so it would drift away from its field if
		// the modal scrolled underneath it.
		this.onScroll = (evt) => {
			if (!this.el.contains(evt.target as Node)) this.close();
		};
		document.addEventListener("mousedown", this.onOutside, true);
		document.addEventListener("scroll", this.onScroll, true);
	}

	/** Below the field when it fits, above it when it does not. */
	place(): void {
		const field = this.anchor.getBoundingClientRect();
		const height = this.el.offsetHeight;
		const below = field.bottom + 4 + height <= window.innerHeight - 8;
		this.el.style.left = `${Math.min(field.left, window.innerWidth - this.el.offsetWidth - 8)}px`;
		this.el.style.top = `${below ? field.bottom + 4 : Math.max(8, field.top - height - 4)}px`;
		this.el.style.minWidth = `${field.width}px`;
	}

	close(): void {
		document.removeEventListener("mousedown", this.onOutside, true);
		document.removeEventListener("scroll", this.onScroll, true);
		this.el.remove();
		this.onClose();
	}
}

/** One row of a popup list. */
interface Choice {
	label: string;
	/** Shown right-aligned and muted, e.g. the end time a duration gives. */
	detail?: string;
	selected?: boolean;
	/** Drawn with a rule above it, to set a different kind of choice apart. */
	divider?: boolean;
	run: () => void;
}

/**
 * Renders choices with keyboard support: Up/Down move, Enter picks. Returns
 * a key handler for the field to forward to while the list is open.
 */
function renderChoices(
	popup: Popup,
	choices: Choice[],
	scrollTo: number
): (evt: KeyboardEvent) => boolean {
	const list = popup.el.createDiv({ cls: "tc-time-list" });
	let active = Math.max(0, scrollTo);
	const rows = choices.map((choice, index) => {
		const row = list.createDiv({ cls: "tc-time-option" });
		row.createSpan({ text: choice.label });
		if (choice.detail) row.createSpan({ cls: "tc-time-detail", text: choice.detail });
		if (choice.selected) row.addClass("is-selected");
		if (choice.divider) row.addClass("tc-time-divider");
		// mousedown, not click: the field's blur would otherwise commit the
		// typed text before the choice lands.
		row.addEventListener("mousedown", (evt) => {
			evt.preventDefault();
			choice.run();
		});
		row.addEventListener("mousemove", () => highlight(index, false));
		return row;
	});

	function highlight(index: number, scroll: boolean): void {
		rows[active]?.removeClass("is-active");
		active = Math.min(Math.max(index, 0), rows.length - 1);
		rows[active]?.addClass("is-active");
		if (scroll) {
			const row = rows[active];
			if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
			else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
				list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
			}
		}
	}

	popup.place();
	highlight(active, false);
	// Centre the starting row, so there is context on both sides of noon.
	const start = rows[active];
	if (start) list.scrollTop = start.offsetTop - list.clientHeight / 2 + start.offsetHeight / 2;

	return (evt) => {
		if (evt.key === "ArrowDown") highlight(active + 1, true);
		else if (evt.key === "ArrowUp") highlight(active - 1, true);
		else if (evt.key === "Enter") choices[active]?.run();
		else return false;
		return true;
	};
}

/** Quarter-hour times across the whole day. */
function dayTimes(): string[] {
	const times: string[] = [];
	for (let minutes = 0; minutes < 1440; minutes += STEP_MINUTES) times.push(fromMinutes(minutes));
	return times;
}

/** The index of the quarter hour at or just before `time`. */
function nearestSlot(time: string): number {
	return Math.floor(toMinutes(time) / STEP_MINUTES);
}

/**
 * A time field: shows "8:00 am", opens a quarter-hour list, and also takes a
 * typed time ("830", "8:30pm", "noon"). Stores "HH:mm".
 */
class TimeInput {
	readonly inputEl: HTMLInputElement;
	private popup: Popup | null = null;
	private keys: ((evt: KeyboardEvent) => boolean) | null = null;

	constructor(
		parent: HTMLElement,
		private placeholder: string,
		private getValue: () => string | undefined,
		private commit: (value: string | undefined) => void,
		private openList: (field: TimeInput) => void
	) {
		this.inputEl = parent.createEl("input", {
			cls: "tc-time-input",
			attr: { type: "text", placeholder, spellcheck: "false", autocomplete: "off" },
		});
		this.show();
		this.inputEl.addEventListener("focus", () => {
			this.inputEl.select();
			this.open();
		});
		this.inputEl.addEventListener("mousedown", () => {
			if (document.activeElement === this.inputEl && !this.popup) this.open();
		});
		this.inputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Escape" && this.popup) {
				// Close the list, not the whole modal.
				evt.preventDefault();
				evt.stopPropagation();
				this.close();
				return;
			}
			if (evt.key === "Enter" && !this.popup) {
				evt.preventDefault();
				this.commitTyped();
				return;
			}
			if (this.popup && this.keys?.(evt)) {
				evt.preventDefault();
				evt.stopPropagation();
			}
		});
		// Typing goes straight to the field; the list only helps pick.
		this.inputEl.addEventListener("input", () => this.close());
		this.inputEl.addEventListener("blur", () => {
			this.commitTyped();
			this.close();
		});
	}

	/** Re-renders the field from the stored value. */
	show(): void {
		const value = this.getValue();
		this.inputEl.value = value ? this.format(value) : "";
		this.inputEl.placeholder = this.placeholder;
	}

	/** How a value is written in the field; the end field adds its length. */
	format: (value: string) => string = formatClock;

	setPlaceholder(text: string): void {
		this.placeholder = text;
		this.inputEl.placeholder = text;
	}

	open(): void {
		this.close();
		this.popup = new Popup(this.inputEl, () => {
			this.popup = null;
			this.keys = null;
		});
		this.openList(this);
	}

	/** Called by the list renderer with its choices. */
	fill(choices: Choice[], startAt: number): void {
		if (!this.popup) return;
		this.popup.el.empty();
		this.keys = renderChoices(this.popup, choices, startAt);
	}

	pick(value: string | undefined): void {
		this.commit(value);
		this.show();
		this.close();
	}

	close(): void {
		this.popup?.close();
	}

	/** Accepts what was typed, or puts the stored value back if it was not a time. */
	private commitTyped(): void {
		const typed = this.inputEl.value.trim();
		const current = this.getValue();
		if (current && typed === this.format(current)) return;
		if (!typed) {
			this.commit(undefined);
			this.show();
			return;
		}
		const parsed = parseClock(typed.replace(/\s*·.*$/, ""));
		if (parsed) this.commit(parsed);
		else this.inputEl.addClass("is-invalid");
		window.setTimeout(() => this.inputEl.removeClass("is-invalid"), 900);
		this.show();
	}
}

export interface TimeRangeOptions {
	getStart: () => string | undefined;
	setStart: (value: string | undefined) => void;
	getEnd: () => string | undefined;
	setEnd: (value: string | undefined) => void;
}

export interface TimeRange {
	startSetting: Setting;
	endSetting: Setting;
	/** Closes any open list; call from the modal's onClose. */
	destroy: () => void;
}

/**
 * The start and end time rows of an event editor.
 *
 * Start opens a quarter-hour list centred on noon when empty. Picking it
 * fills an end one hour later -- or keeps the existing length when a start
 * is moved -- and opens the end list: 30 minutes to 4 hours, each with the
 * end time it gives, then "Custom end time" for the full list.
 */
export function renderTimeRange(container: HTMLElement, options: TimeRangeOptions): TimeRange {
	const { getStart, setStart, getEnd, setEnd } = options;

	const startSetting = new Setting(container).setName("Start time");
	const endSetting = new Setting(container).setName("End time");

	let end: TimeInput;
	const start = new TimeInput(
		startSetting.controlEl,
		"Pick a time",
		getStart,
		(value) => {
			const previous = getStart();
			const oldEnd = getEnd();
			setStart(value);
			if (!value) return;
			// Moving a start keeps the event's length; a first start gets an hour.
			const length = previous && oldEnd ? durationMinutes(previous, oldEnd) : 60;
			setEnd(fromMinutes(toMinutes(value) + length));
			end.show();
			refreshEnd();
			// Offer the lengths straight away, which is the next thing to decide.
			if (!previous) window.setTimeout(() => end.inputEl.focus());
		},
		(field) => {
			const times = dayTimes();
			const current = getStart();
			field.fill(
				times.map((time) => ({
					label: formatClock(time),
					selected: time === current,
					run: () => field.pick(time),
				})),
				nearestSlot(current ?? DEFAULT_START)
			);
		}
	);

	end = new TimeInput(
		endSetting.controlEl,
		"Pick a start time first",
		getEnd,
		(value) => setEnd(value),
		(field) => {
			const from = getStart();
			if (!from) {
				field.close();
				start.inputEl.focus();
				return;
			}
			const currentLength = getEnd() ? durationMinutes(from, getEnd() as string) : undefined;
			const choices: Choice[] = PRESET_DURATIONS.map((minutes) => {
				const until = fromMinutes(toMinutes(from) + minutes);
				return {
					label: formatDuration(minutes),
					detail: `ends ${formatClock(until)}`,
					selected: minutes === currentLength,
					run: () => field.pick(until),
				};
			});
			choices.push({
				label: "Custom end time…",
				divider: true,
				run: () => showAllEndTimes(field, from),
			});
			const selected = choices.findIndex((choice) => choice.selected);
			field.fill(choices, selected >= 0 ? selected : 1);
		}
	);
	// "9:00 am · 1 hour": the length is what the popup is about, so the field
	// says it too.
	end.format = (value) => {
		const from = getStart();
		return from ? `${formatClock(value)} · ${formatDuration(durationMinutes(from, value))}` : formatClock(value);
	};

	/** Every quarter hour after the start, through the next 24 hours. */
	function showAllEndTimes(field: TimeInput, from: string): void {
		const first = toMinutes(from) + STEP_MINUTES;
		const current = getEnd();
		const choices: Choice[] = [];
		for (let minutes = first; minutes < first + 1440 - STEP_MINUTES; minutes += STEP_MINUTES) {
			const time = fromMinutes(minutes);
			choices.push({
				label: formatClock(time),
				detail: formatDuration(minutes - toMinutes(from)),
				selected: time === current,
				run: () => field.pick(time),
			});
		}
		const selected = choices.findIndex((choice) => choice.selected);
		field.fill(choices, selected >= 0 ? selected : 3);
	}

	function refreshEnd(): void {
		end.setPlaceholder(getStart() ? "Pick an end time" : "Pick a start time first");
		end.show();
	}
	refreshEnd();

	return {
		startSetting,
		endSetting,
		destroy: () => {
			start.close();
			end.close();
		},
	};
}
