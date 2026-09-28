import { ItemView, WorkspaceLeaf } from "obsidian";
import type TypedCalendarPlugin from "../../main";
import { buildPriorityRows, indexTypes, PriorityRow } from "../model/priority";
import { formatRelativeDays } from "../util/dates";
import { EventType } from "../model/types";
import {
	PRIORITY_VIEW,
	colorFor,
	matchesFilters,
	renderFilterBar,
} from "./shared";

export class PriorityView extends ItemView {
	private unsubscribe: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: TypedCalendarPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return PRIORITY_VIEW;
	}

	getDisplayText(): string {
		return "Priority";
	}

	getIcon(): string {
		return "list-ordered";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("tc-view");
		this.unsubscribe = this.plugin.index.onChange(() => this.refresh());
		this.refresh();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	refresh(): void {
		const root = this.contentEl;
		root.empty();

		const active = this.plugin.settings.activeFilters;
		renderFilterBar(root, this.plugin.settings.eventTypes, active, (id) =>
			void this.plugin.toggleFilter(id)
		);

		const events = this.plugin.index
			.scheduled()
			.filter((event) => matchesFilters(event, active));
		const rows = buildPriorityRows(
			events,
			this.plugin.settings.eventTypes,
			this.plugin.settings.priorityHorizonDays
		);

		const list = root.createDiv({ cls: "tc-list" });
		if (rows.length === 0) {
			list.createDiv({
				cls: "tc-empty",
				text: `Nothing scheduled in the next ${this.plugin.settings.priorityHorizonDays} days.`,
			});
			return;
		}

		const typeMap = indexTypes(this.plugin.settings.eventTypes);
		for (const row of rows) {
			this.renderRow(list, row, typeMap);
		}
	}

	private renderRow(
		list: HTMLElement,
		row: PriorityRow,
		typeMap: Map<string, EventType>
	): void {
		const item = list.createDiv({ cls: "tc-row" });
		const accent = colorFor(row.event, typeMap);
		if (accent) item.style.setProperty("--tc-row-color", accent);

		// Urgency reads better as the leading column than buried in the meta
		// line -- it is the reason this view exists.
		item.createDiv({
			cls: `tc-row-when${row.days <= 1 ? " is-urgent" : ""}`,
			text: formatRelativeDays(row.days),
		});

		const body = item.createDiv({ cls: "tc-row-body" });
		body.createDiv({ cls: "tc-row-title", text: row.title });

		const meta = body.createDiv({ cls: "tc-row-meta" });
		for (const id of row.event.types) {
			const type = typeMap.get(id);
			const badge = meta.createSpan({ cls: "tc-badge", text: type?.label ?? id });
			if (type) badge.style.setProperty("--tc-chip-color", type.color);
		}
		for (const annotation of row.annotations) {
			meta.createSpan({ cls: "tc-meta-item", text: annotation });
		}

		// Pass the occurrence: for a weekly class, the row the user clicked is
		// the one they may want to cancel.
		item.addEventListener("click", () =>
			this.plugin.openEventModal(row.event, undefined, row.occurrence)
		);
	}
}
