import { App, Modal, Notice, Setting } from "obsidian";
import { CalendarEvent, OccurrenceOverride } from "../model/types";
import { applyOverride, buildOverride } from "../model/occurrences";
import { TimeRange, renderTimeRange } from "./TimeField";

/**
 * Edits one occurrence of a repeating event: moved to another day, a
 * different time, another room.
 *
 * Only what differs from the series is stored, so a later change to the
 * series -- a new title for the course, say -- still reaches this occurrence
 * wherever it did not deliberately diverge.
 */
export class OccurrenceModal extends Modal {
	private date: string;
	private allDay: boolean;
	private startTime?: string;
	private endTime?: string;
	private title: string;
	private location: string;
	private readonly existing?: OccurrenceOverride;
	private times: TimeRange | null = null;

	constructor(
		app: App,
		private event: CalendarEvent,
		private occurrence: string,
		private onSave: (override: OccurrenceOverride) => void,
		private onReset: () => void
	) {
		super(app);
		this.existing = event.overrides?.find((override) => override.occurrence === occurrence);
		const instance = applyOverride(event, occurrence, this.existing);
		this.date = instance.date;
		this.allDay = instance.allDay;
		this.startTime = instance.startTime;
		this.endTime = instance.endTime;
		// Blank means "same as the series", so only a real divergence is
		// prefilled; typing into a prefilled series value would otherwise pin
		// it to this occurrence forever.
		this.title = this.existing?.title ?? "";
		this.location = this.existing?.location ?? "";
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("tc-modal");
		this.setTitle("Change one occurrence");

		contentEl.createEl("p", {
			cls: "setting-item-description",
			text:
				`Only the ${this.occurrence} occurrence of "${this.event.title}". ` +
				"Every other date in the series stays as it is.",
		});

		new Setting(contentEl)
			.setName("Date")
			.setDesc("Move this occurrence to another day.")
			.addText((text) => {
				text.inputEl.type = "date";
				text.setValue(this.date).onChange((value) => {
					if (value) this.date = value;
				});
			});

		let showTimes = (): void => {};
		new Setting(contentEl).setName("All day").addToggle((toggle) =>
			toggle.setValue(this.allDay).onChange((value) => {
				this.allDay = value;
				showTimes();
			})
		);
		this.times = renderTimeRange(contentEl, {
			getStart: () => this.startTime,
			setStart: (value) => (this.startTime = value),
			getEnd: () => this.endTime,
			setEnd: (value) => (this.endTime = value),
		});
		const { startSetting, endSetting } = this.times;
		showTimes = () => {
			startSetting.settingEl.toggleClass("tc-hidden", this.allDay);
			endSetting.settingEl.toggleClass("tc-hidden", this.allDay);
		};
		showTimes();

		new Setting(contentEl)
			.setName("Title")
			.setDesc("Leave empty to use the series' title.")
			.addText((text) =>
				text
					.setPlaceholder(this.event.title)
					.setValue(this.title)
					.onChange((value) => (this.title = value))
			);

		new Setting(contentEl)
			.setName("Location")
			.setDesc("Leave empty to use the series' location.")
			.addText((text) =>
				text
					.setPlaceholder(this.event.location ?? "")
					.setValue(this.location)
					.onChange((value) => (this.location = value))
			);

		const buttons = new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Save")
				.setCta()
				.onClick(() => this.save())
		);
		if (this.existing) {
			buttons.addButton((button) =>
				button
					.setButtonText("Reset to series")
					.setWarning()
					.onClick(() => {
						this.onReset();
						this.close();
					})
			);
		}
		buttons.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void {
		this.times?.destroy();
		this.contentEl.empty();
	}

	private save(): void {
		if (!this.allDay && !this.startTime) {
			new Notice("A timed occurrence needs a start time.");
			return;
		}

		const override = buildOverride(
			this.event,
			this.occurrence,
			{
				date: this.date,
				allDay: this.allDay,
				startTime: this.startTime,
				endTime: this.endTime,
				title: this.title,
				location: this.location,
			},
			this.existing
		);
		// Null: nothing differs and nothing was there before, so saving would
		// only add an empty entry to the note.
		if (override) this.onSave(override);
		this.close();
	}
}
