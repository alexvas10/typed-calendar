import { App, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import { CalendarEvent, EventType, TypeField } from "../model/types";
import { generateUid } from "../model/serialize";
import { indexTypes } from "../model/priority";
import {
	Frequency,
	RecurrenceRule,
	WEEKDAYS,
	Weekday,
	describeRecurrence,
} from "../model/recurrence";
import { weekdayOf } from "../util/dates";
import type TypedCalendarPlugin from "../../main";

export class EventModal extends Modal {
	private draft: CalendarEvent;
	private readonly isNew: boolean;
	/** The occurrence the user clicked, when they opened a repeating event. */
	private readonly occurrence?: string;
	private propsEl!: HTMLElement;
	private repeatEl!: HTMLElement;

	constructor(
		app: App,
		private plugin: TypedCalendarPlugin,
		existing?: CalendarEvent,
		prefillDate?: string,
		occurrence?: string
	) {
		super(app);
		this.isNew = !existing;
		this.occurrence = occurrence;
		this.draft = existing
			? {
					...existing,
					types: [...existing.types],
					props: { ...existing.props },
					recurrence: existing.recurrence ? { ...existing.recurrence } : undefined,
					exceptions: existing.exceptions ? [...existing.exceptions] : undefined,
				}
			: {
					uid: generateUid(),
					title: "",
					types: [],
					allDay: true,
					status: "confirmed",
					date: prefillDate,
					props: {},
					timezone: plugin.settings.defaultTimezone,
					path: "",
				};
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("tc-modal");
		this.setTitle(this.isNew ? "New event" : "Edit event");

		new Setting(contentEl).setName("Title").addText((text) =>
			text
				.setPlaceholder("CS 3600 Midterm")
				.setValue(this.draft.title)
				.onChange((value) => (this.draft.title = value))
		);

		this.renderTypeToggles(contentEl);

		new Setting(contentEl)
			.setName("Date")
			.setDesc(
				this.draft.recurrence
					? "The first occurrence. The repeat rule counts from here."
					: "Leave empty to keep this in Expecting Soon."
			)
			.addText((text) => {
				text.inputEl.type = "date";
				text.setValue(this.draft.date ?? "").onChange((value) => {
					this.draft.date = value || undefined;
				});
			});

		// Declared before the toggle that drives it, because the toggle is
		// rendered above the rows it hides.
		let showTimes = (): void => {};

		new Setting(contentEl)
			.setName("All day")
			.setDesc("Runs midnight to midnight, so it carries no start or end time.")
			.addToggle((toggle) =>
				toggle.setValue(this.draft.allDay).onChange((value) => {
					this.draft.allDay = value;
					showTimes();
				})
			);

		const startSetting = new Setting(contentEl).setName("Start time").addText((text) => {
			text.inputEl.type = "time";
			text.setValue(this.draft.startTime ?? "").onChange((value) => {
				this.draft.startTime = value || undefined;
			});
		});

		const endSetting = new Setting(contentEl).setName("End time").addText((text) => {
			text.inputEl.type = "time";
			text.setValue(this.draft.endTime ?? "").onChange((value) => {
				this.draft.endTime = value || undefined;
			});
		});

		// The values are kept rather than cleared, so turning the toggle back off
		// returns what the user had typed. submit() drops them for an all-day
		// event, which is what actually decides the stored shape.
		showTimes = () => {
			startSetting.settingEl.toggleClass("tc-hidden", this.draft.allDay);
			endSetting.settingEl.toggleClass("tc-hidden", this.draft.allDay);
		};
		showTimes();

		new Setting(contentEl).setName("Location").addText((text) =>
			text
				.setPlaceholder("MC 4021")
				.setValue(this.draft.location ?? "")
				.onChange((value) => (this.draft.location = value || undefined))
		);

		this.repeatEl = contentEl.createDiv();
		this.renderRepeat();

		new Setting(contentEl)
			.setName("Awaiting details")
			.setDesc("Keeps the event out of the calendar and out of iCloud even if it has a date.")
			.addToggle((toggle) =>
				toggle.setValue(this.draft.status === "tbd").onChange((value) => {
					this.draft.status = value ? "tbd" : "confirmed";
				})
			);

		this.propsEl = contentEl.createDiv();
		this.renderProps();

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(this.isNew ? "Create" : "Save")
					.setCta()
					.onClick(() => void this.submit())
			)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));

		if (!this.isNew) {
			new Setting(contentEl)
				.addButton((button) =>
					button.setButtonText("Open note").onClick(() => {
						const file = this.app.vault.getAbstractFileByPath(this.draft.path);
						if (isMarkdownFile(file)) {
							void this.app.workspace.getLeaf("tab").openFile(file);
							this.close();
						}
					})
				)
				.addButton((button) => {
					// Two clicks rather than a confirm dialog: this removes the
					// event from iCloud as well as the vault, and the second click
					// has to be deliberate.
					let armed = false;
					button.setButtonText("Delete").setWarning();
					button.onClick(() => {
						if (!armed) {
							armed = true;
							button.setButtonText("Delete from iCloud too?");
							window.setTimeout(() => {
								armed = false;
								button.setButtonText("Delete");
							}, 4000);
							return;
						}
						void this.remove();
					});
				});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderTypeToggles(container: HTMLElement): void {
		const setting = new Setting(container)
			.setName("Types")
			.setDesc("An event can carry several types and matches a filter for any of them.");
		// A dozen chips do not fit in the narrow control column beside the
		// description; this stacks them underneath it instead of over it.
		setting.settingEl.addClass("tc-types-setting");

		const wrapper = setting.controlEl.createDiv({ cls: "tc-filter-bar tc-modal-types" });
		for (const type of this.plugin.settings.eventTypes) {
			const chip = wrapper.createEl("button", { cls: "tc-chip", text: type.label });
			chip.style.setProperty("--tc-chip-color", type.color);
			const sync = () => chip.toggleClass("is-active", this.draft.types.includes(type.id));
			sync();
			chip.addEventListener("click", (evt) => {
				// Inside a modal the button would otherwise submit the form.
				evt.preventDefault();
				this.draft.types = this.draft.types.includes(type.id)
					? this.draft.types.filter((id) => id !== type.id)
					: [...this.draft.types, type.id];
				sync();
				this.renderProps();
			});
		}
	}

	/** Custom fields are the union of the fields declared by selected types. */
	private renderProps(): void {
		this.propsEl.empty();
		const typeMap = indexTypes(this.plugin.settings.eventTypes);
		const fields = collectFields(this.draft.types, typeMap);
		if (fields.length === 0) return;

		new Setting(this.propsEl).setName("Details").setHeading();
		for (const field of fields) {
			this.renderField(field);
		}
	}

	private renderField(field: TypeField): void {
		const setting = new Setting(this.propsEl).setName(field.label);
		if (field.unit) setting.setDesc(`Measured in ${field.unit}`);
		const current = this.draft.props[field.key];

		const store = (value: unknown) => {
			if (value === "" || value === undefined || value === null) {
				delete this.draft.props[field.key];
			} else {
				this.draft.props[field.key] = value;
			}
		};

		if (field.type === "checkbox") {
			setting.addToggle((toggle) =>
				toggle.setValue(current === true).onChange((value) => store(value || undefined))
			);
			return;
		}

		if (field.type === "select") {
			setting.addDropdown((dropdown) => {
				dropdown.addOption("", "—");
				for (const option of field.options ?? []) dropdown.addOption(option, option);
				dropdown.setValue(current === undefined ? "" : String(current));
				dropdown.onChange((value) => store(value));
			});
			return;
		}

		setting.addText((text) => {
			if (field.type === "number") text.inputEl.type = "number";
			if (field.type === "date") text.inputEl.type = "date";
			text.setValue(current === undefined ? "" : String(current));
			text.onChange((value) => {
				if (field.type !== "number") return store(value);
				const parsed = Number(value);
				// Keep a non-numeric entry as text rather than silently dropping
				// what the user typed.
				store(value === "" ? undefined : isNaN(parsed) ? value : parsed);
			});
		});
	}

	/**
	 * The repeat controls, re-rendered in place because choosing "weekly"
	 * reveals a weekday picker and choosing "does not repeat" removes it.
	 */
	private renderRepeat(): void {
		this.repeatEl.empty();
		const rule = this.draft.recurrence;

		new Setting(this.repeatEl)
			.setName("Repeats")
			.setDesc(
				rule
					? `${describeRecurrence(rule)}. Changes here apply to the whole series.`
					: "Turn a weekly class into one note that fills in every week."
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("none", "Does not repeat");
				dropdown.addOption("daily", "Daily");
				dropdown.addOption("weekly", "Weekly");
				dropdown.addOption("monthly", "Monthly");
				dropdown.addOption("yearly", "Yearly");
				dropdown.setValue(rule?.freq ?? "none");
				dropdown.onChange((value) => {
					this.draft.recurrence =
						value === "none" ? undefined : this.ruleFor(value as Frequency);
					if (!this.draft.recurrence) this.draft.exceptions = undefined;
					this.renderRepeat();
				});
			});

		if (!rule) {
			// Turning a repeat off cannot be pushed: from the server's side it
			// is indistinguishable from a note that never knew about the rule,
			// and guessing wrong deletes a whole term of classes.
			if (this.draft.icloud?.recurring) {
				this.repeatEl.createEl("p", {
					cls: "setting-item-description tc-settings-note",
					text:
						"This event still repeats on iCloud. Removing the repeat here is not " +
						"sent to the server \u2014 delete the event and create it again instead.",
				});
			}
			return;
		}

		const plural: Record<Frequency, string> = {
			daily: "days",
			weekly: "weeks",
			monthly: "months",
			yearly: "years",
		};
		new Setting(this.repeatEl)
			.setName("Repeat every")
			.setDesc(`Number of ${plural[rule.freq]} between occurrences. 1 means every one.`)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.setValue(String(rule.interval)).onChange((value) => {
					const parsed = Number(value);
					if (Number.isInteger(parsed) && parsed >= 1) {
						rule.interval = parsed;
						this.renderRepeatSummary();
					}
				});
			});

		if (rule.freq === "weekly") this.renderWeekdayPicker(rule);

		new Setting(this.repeatEl)
			.setName("Repeat until")
			.setDesc("The last date the series may fall on. Leave empty to repeat indefinitely.")
			.addText((text) => {
				text.inputEl.type = "date";
				text.setValue(rule.until ?? "").onChange((value) => {
					rule.until = value || undefined;
					// UNTIL and a total count cannot both apply; the end date
					// is the one a person actually reasoned about.
					if (rule.until) delete rule.count;
					this.renderRepeatSummary();
				});
			});

		this.renderExceptions();
	}

	/** Refreshes only the description line, so typing does not steal focus. */
	private renderRepeatSummary(): void {
		const rule = this.draft.recurrence;
		if (!rule) {
			// Turning a repeat off cannot be pushed: from the server's side it
			// is indistinguishable from a note that never knew about the rule,
			// and guessing wrong deletes a whole term of classes.
			if (this.draft.icloud?.recurring) {
				this.repeatEl.createEl("p", {
					cls: "setting-item-description tc-settings-note",
					text:
						"This event still repeats on iCloud. Removing the repeat here is not " +
						"sent to the server \u2014 delete the event and create it again instead.",
				});
			}
			return;
		}
		const desc = this.repeatEl.querySelector(".setting-item-description");
		if (desc) {
			desc.textContent = `${describeRecurrence(rule)}. Changes here apply to the whole series.`;
		}
	}

	private renderWeekdayPicker(rule: RecurrenceRule): void {
		const labels: Record<Weekday, string> = {
			SU: "Sun", MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat",
		};
		const setting = new Setting(this.repeatEl)
			.setName("Repeat on")
			.setDesc("Pick several for a class that meets more than once a week.");

		const wrapper = setting.controlEl.createDiv({ cls: "tc-filter-bar tc-modal-types" });
		for (const day of WEEKDAYS) {
			const chip = wrapper.createEl("button", { cls: "tc-chip", text: labels[day] });
			const sync = () => chip.toggleClass("is-active", Boolean(rule.byDay?.includes(day)));
			sync();
			chip.addEventListener("click", (evt) => {
				evt.preventDefault();
				const selected = new Set(rule.byDay ?? []);
				if (selected.has(day)) selected.delete(day);
				else selected.add(day);
				// An empty set would mean "the start day" implicitly; keeping
				// it explicit is what the rest of the code expects to write.
				rule.byDay = selected.size > 0 ? WEEKDAYS.filter((d) => selected.has(d)) : undefined;
				sync();
				this.renderRepeatSummary();
			});
		}
	}

	/**
	 * Skipped occurrences: a class that falls on a holiday. They are listed
	 * rather than hidden so a cancellation made by accident can be undone.
	 */
	private renderExceptions(): void {
		const skipped = this.draft.exceptions ?? [];

		if (this.occurrence) {
			const isSkipped = skipped.includes(this.occurrence);
			new Setting(this.repeatEl)
				.setName(`This occurrence — ${this.occurrence}`)
				.setDesc(
					isSkipped
						? "Currently skipped. The rest of the series is unaffected."
						: "Remove just this date, for a holiday or a cancelled class."
				)
				.addButton((button) =>
					button
						.setButtonText(isSkipped ? "Restore this occurrence" : "Skip this occurrence")
						.setWarning()
						.onClick(() => {
							this.toggleException(this.occurrence as string);
							void this.submit();
						})
				);
		}

		if (skipped.length === 0) return;

		const setting = new Setting(this.repeatEl)
			.setName("Skipped dates")
			.setDesc("Dates the series does not happen on.");
		const list = setting.controlEl.createDiv({ cls: "tc-filter-bar tc-modal-types" });
		for (const date of [...skipped].sort()) {
			const chip = list.createEl("button", { cls: "tc-chip is-active", text: `${date} ✕` });
			chip.addEventListener("click", (evt) => {
				evt.preventDefault();
				this.toggleException(date);
				this.renderRepeat();
			});
		}
	}

	private toggleException(date: string): void {
		const skipped = new Set(this.draft.exceptions ?? []);
		if (skipped.has(date)) skipped.delete(date);
		else skipped.add(date);
		this.draft.exceptions = skipped.size > 0 ? Array.from(skipped).sort() : undefined;
	}

	/** A sensible rule for a frequency the user just picked. */
	private ruleFor(freq: Frequency): RecurrenceRule {
		const rule: RecurrenceRule = { freq, interval: this.draft.recurrence?.interval ?? 1 };
		if (freq === "weekly") {
			// Default to the day the event already falls on, which is almost
			// always what someone means by "weekly".
			const start = this.draft.date;
			rule.byDay = start ? [WEEKDAYS[weekdayOf(start)]] : undefined;
		}
		const until = this.draft.recurrence?.until;
		if (until) rule.until = until;
		return rule;
	}

	/** Deletes the event everywhere: iCloud first, then the note. */
	private async remove(): Promise<void> {
		try {
			await this.plugin.deleteEvent(this.draft);
			new Notice(`Deleted "${this.draft.title}".`);
			this.close();
		} catch (error) {
			console.error("Typed Calendar: failed to delete event", error);
			new Notice((error as Error).message);
		}
	}

	private async submit(): Promise<void> {
		const title = this.draft.title.trim();
		if (!title) {
			new Notice("An event needs a title.");
			return;
		}
		this.draft.title = title;
		if (this.draft.recurrence && !this.draft.date) {
			new Notice("A repeating event needs a start date.");
			return;
		}
		if (this.draft.allDay) {
			this.draft.startTime = undefined;
			this.draft.endTime = undefined;
		}

		try {
			await this.plugin.writeEvent(this.draft, this.isNew);
			this.close();
		} catch (error) {
			console.error("Typed Calendar: failed to save event", error);
			new Notice(`Could not save event: ${(error as Error).message}`);
		}
	}
}

export function collectFields(
	typeIds: string[],
	typeMap: Map<string, EventType>
): TypeField[] {
	const out: TypeField[] = [];
	const seen = new Set<string>();
	for (const id of typeIds) {
		for (const field of typeMap.get(id)?.fields ?? []) {
			if (seen.has(field.key)) continue;
			seen.add(field.key);
			out.push(field);
		}
	}
	return out;
}

/** Strips characters Obsidian will not accept in a file name. */
export function eventFileName(event: CalendarEvent): string {
	const safeTitle = event.title.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "Untitled event";
	const prefix = event.date ? `${event.date} ` : "";
	return `${prefix}${safeTitle}`;
}

export function eventFilePath(folder: string, event: CalendarEvent): string {
	const base = eventFileName(event);
	return normalizePath(folder ? `${folder}/${base}.md` : `${base}.md`);
}

export function isMarkdownFile(file: unknown): file is TFile {
	return file instanceof TFile && file.extension === "md";
}
