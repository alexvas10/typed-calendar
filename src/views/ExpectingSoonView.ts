import { ItemView, WorkspaceLeaf } from "obsidian";
import type TypedCalendarPlugin from "../../main";
import { indexTypes, missingFields } from "../model/priority";
import {
	EXPECTING_VIEW,
	colorFor,
	matchesFilters,
	renderFilterBar,
} from "./shared";

/**
 * Events that exist but are not yet real calendar entries -- a final exam
 * listed as "TBD". They never reach the grid and never reach iCloud, which is
 * the whole point: they are tracked without inventing a date for them.
 */
export class ExpectingSoonView extends ItemView {
	private unsubscribe: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: TypedCalendarPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return EXPECTING_VIEW;
	}

	getDisplayText(): string {
		return "Expecting soon";
	}

	getIcon(): string {
		return "clock-alert";
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

		const typeMap = indexTypes(this.plugin.settings.eventTypes);
		const events = this.plugin.index
			.unscheduled()
			.filter((event) => matchesFilters(event, active))
			.sort((a, b) => a.title.localeCompare(b.title));

		const list = root.createDiv({ cls: "tc-list" });
		if (events.length === 0) {
			list.createDiv({ cls: "tc-empty", text: "Nothing waiting on a date." });
			return;
		}

		for (const event of events) {
			const item = list.createDiv({ cls: "tc-row" });
			const accent = colorFor(event, typeMap);
			if (accent) item.style.setProperty("--tc-row-color", accent);

			item.createDiv({ cls: "tc-row-when is-pending", text: "TBD" });

			const body = item.createDiv({ cls: "tc-row-body" });
			body.createDiv({ cls: "tc-row-title", text: event.title });

			const meta = body.createDiv({ cls: "tc-row-meta" });
			for (const id of event.types) {
				const type = typeMap.get(id);
				const badge = meta.createSpan({ cls: "tc-badge", text: type?.label ?? id });
				if (type) badge.style.setProperty("--tc-chip-color", type.color);
			}
			const missing = missingFields(event, typeMap);
			if (missing.length > 0) {
				meta.createSpan({
					cls: "tc-meta-item tc-missing",
					text: `needs ${missing.join(", ")}`,
				});
			}

			item.addEventListener("click", () => this.plugin.openEventModal(event));
		}
	}
}
