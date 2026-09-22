import { App, Modal, Notice, Setting } from "obsidian";
import { EventType } from "../model/types";
import type TypedCalendarPlugin from "../../main";

/**
 * Creates an event type without leaving the calendar.
 *
 * Deliberately only the three things needed to start using a type: what it is
 * called, what colour it draws in, and where it sorts. Custom fields and the
 * iCloud calendar mapping stay in settings -- they are configuration, not
 * something to decide while looking at a week's schedule, and the mapping in
 * particular changes where events are written on a real account.
 */
export class TypeModal extends Modal {
	private label = "";
	private color = "#888888";
	private rank = 10;

	constructor(
		app: App,
		private plugin: TypedCalendarPlugin,
		/** Called with the new type once it is saved. */
		private onCreated?: (type: EventType) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("New event type");

		new Setting(contentEl).setName("Name").addText((text) => {
			text.setPlaceholder("Lecture").onChange((value) => (this.label = value));
			// The name is the only required field, so start the cursor there.
			window.setTimeout(() => text.inputEl.focus(), 0);
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") void this.submit();
			});
		});

		new Setting(contentEl)
			.setName("Colour")
			.setDesc("Used for this type's chip and for events carrying it.")
			.addColorPicker((picker) =>
				picker.setValue(this.color).onChange((value) => (this.color = value))
			);

		new Setting(contentEl)
			.setName("Rank")
			.setDesc(
				"Higher ranks sort first in the priority view. When an event carries " +
					"several types, the highest-ranked one decides which iCloud calendar " +
					"it is written to."
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(this.rank)).onChange((value) => {
					const parsed = Number(value);
					if (!isNaN(parsed)) this.rank = Math.round(parsed);
				});
			});

		contentEl.createEl("p", {
			cls: "setting-item-description tc-settings-note",
			text:
				"Custom fields and the iCloud calendar this type syncs to are in " +
				"Settings → Typed Calendar.",
		});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("Create")
					.setCta()
					.onClick(() => void this.submit())
			)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async submit(): Promise<void> {
		const label = this.label.trim();
		if (!label) {
			new Notice("A type needs a name.");
			return;
		}
		try {
			const type = await this.plugin.createType(label, this.color, this.rank);
			new Notice(`Added the "${type.label}" type.`);
			this.onCreated?.(type);
			this.close();
		} catch (error) {
			console.error("Typed Calendar: failed to create type", error);
			new Notice((error as Error).message);
		}
	}
}
