import { App, TFile, WorkspaceLeaf } from "obsidian";
import { CalendarEvent, EventType } from "../model/types";

export const CALENDAR_VIEW = "typed-calendar-grid";
export const PRIORITY_VIEW = "typed-calendar-priority";
export const EXPECTING_VIEW = "typed-calendar-expecting";

/**
 * An empty filter set means "no filter applied", not "hide everything" --
 * otherwise a fresh install would open to a blank calendar.
 */
export function matchesFilters(event: CalendarEvent, active: string[]): boolean {
	if (active.length === 0) return true;
	return event.types.some((type) => active.includes(type));
}

/** First type that has a colour wins; untyped events fall back to the theme. */
export function colorFor(
	event: CalendarEvent,
	types: Map<string, EventType>
): string | undefined {
	for (const id of event.types) {
		const color = types.get(id)?.color;
		if (color) return color;
	}
	return undefined;
}

export async function openEventNote(
	app: App,
	event: CalendarEvent,
	leaf?: WorkspaceLeaf
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(event.path);
	if (!(file instanceof TFile)) return;
	const target = leaf ?? app.workspace.getLeaf("tab");
	await target.openFile(file);
}

/**
 * Renders one chip per type; clicking toggles it in the shared filter set.
 *
 * `onCreate` adds a trailing "+ New type" chip. It is optional because only
 * the calendar offers it: the priority and expecting-soon lists are for
 * reading, and a type created from them would have nothing to apply to.
 */
export function renderFilterBar(
	container: HTMLElement,
	types: EventType[],
	active: string[],
	onToggle: (id: string) => void,
	onCreate?: () => void
): void {
	const bar = container.createDiv({ cls: "tc-filter-bar" });
	for (const type of types) {
		const isActive = active.includes(type.id);
		const chip = bar.createEl("button", {
			cls: `tc-chip${isActive ? " is-active" : ""}`,
			text: type.label,
		});
		chip.style.setProperty("--tc-chip-color", type.color);
		chip.addEventListener("click", () => onToggle(type.id));
	}
	if (active.length > 0) {
		const clear = bar.createEl("button", { cls: "tc-chip tc-chip-clear", text: "Clear" });
		clear.addEventListener("click", () => onToggle("__clear__"));
	}
	if (onCreate) {
		const add = bar.createEl("button", {
			cls: "tc-chip tc-chip-clear tc-chip-add",
			text: "+ New type",
		});
		add.setAttr("aria-label", "Create an event type");
		add.addEventListener("click", () => onCreate());
	}
}
