import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TypedCalendarPlugin from "../../main";
import { EventType, FieldType, TypeField } from "../model/types";
import { autoMapCalendars } from "../sync/routing";

const FIELD_TYPES: Record<FieldType, string> = {
	text: "Text",
	number: "Number",
	date: "Date",
	select: "Choice",
	checkbox: "Checkbox",
};

export class TypedCalendarSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: TypedCalendarPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Event folder")
			.setDesc("Notes in this folder are indexed as events. Leave empty to scan the whole vault.")
			.addText((text) =>
				text
					.setPlaceholder("Calendar/Events")
					.setValue(this.plugin.settings.eventFolder)
					.onChange(async (value) => {
						this.plugin.settings.eventFolder = value.replace(/^\/+|\/+$/g, "");
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Priority horizon")
			.setDesc("How many days ahead the priority view looks.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.priorityHorizonDays))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.priorityHorizonDays = Math.round(parsed);
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Default timezone")
			.setDesc("Written onto new events that do not specify one.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.defaultTimezone)
					.onChange(async (value) => {
						this.plugin.settings.defaultTimezone = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Write agent documentation")
			.setDesc(
				"Keep EVENT_SCHEMA.md, event-schema.json and event-types.json in the event folder so AI agents can read the format."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.writeAgentDocs)
					.onChange(async (value) => {
						this.plugin.settings.writeAgentDocs = value;
						await this.plugin.saveSettings();
					})
			);

		this.renderSync(containerEl);

		new Setting(containerEl).setName("Event types").setHeading();

		if (this.plugin.settings.caldav.calendars.length > 0) {
			containerEl.createEl("p", {
				cls: "setting-item-description tc-settings-note",
				text:
					"iCloud has no tags: an event lives in exactly one calendar. Each type " +
					"can map to one, and an event is sent to the calendar of its " +
					"highest-ranked mapped type. Types left unmapped (course tags, say) " +
					"never affect where an event goes.",
			});
		}

		for (const type of this.plugin.settings.eventTypes) {
			this.renderType(containerEl, type);
		}

		new Setting(containerEl).addButton((button) =>
			button
				.setButtonText("Add event type")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.eventTypes.push({
						id: `type-${Date.now().toString(36)}`,
						label: "New type",
						color: "#888888",
						rank: 10,
						fields: [],
					});
					await this.plugin.saveSettings();
					this.display();
				})
		);
	}

	private renderSync(containerEl: HTMLElement): void {
		const { caldav } = this.plugin.settings;

		new Setting(containerEl).setName("iCloud sync").setHeading();

		containerEl.createEl("p", {
			cls: "setting-item-description tc-settings-note",
			text:
				"Use an app-specific password from appleid.apple.com, not your Apple ID password. " +
				"Obsidian stores plugin settings unencrypted, so this password sits in plaintext " +
				"in your vault; an app-specific password can be revoked on its own if that matters.",
		});

		new Setting(containerEl)
			.setName("Apple ID")
			.addText((text) =>
				text
					.setPlaceholder("you@icloud.com")
					.setValue(caldav.username)
					.onChange(async (value) => {
						caldav.username = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("App-specific password")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(caldav.password).onChange(async (value) => {
					caldav.password = value.trim();
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Calendars")
			.setDesc(
				caldav.calendars.length > 0
					? "Toggle which calendars take part in sync."
					: "Discover the calendars on your account. No URL hunting required."
			)
			.addButton((button) =>
				button
					.setButtonText("Discover calendars")
					.setCta()
					.onClick(async () => {
						button.setButtonText("Discovering…").setDisabled(true);
						try {
							const found = await this.plugin.sync.client().discoverCalendars();
							// Preserve existing enable choices across a re-discovery.
							const previous = new Map(caldav.calendars.map((c) => [c.url, c.enabled]));
							caldav.calendars = found.map((calendar) => ({
								url: calendar.url,
								displayName: calendar.displayName,
								readOnly: calendar.readOnly,
								enabled: previous.get(calendar.url) ?? false,
							}));
							// Wire calendars to types by name so a fresh setup
							// syncs sensibly without manual mapping first.
							const mapped = autoMapCalendars(
								this.plugin.settings.eventTypes,
								caldav.calendars
							);
							this.plugin.settings.eventTypes = mapped.types;
							await this.plugin.saveSettings();
							new Notice(
								`Found ${found.length} calendar(s).\n` +
									(mapped.mappings.length
										? mapped.mappings.join("\n")
										: "No new mappings.")
							);
							this.display();
						} catch (error) {
							new Notice(`Discovery failed: ${(error as Error).message}`);
							button.setButtonText("Discover calendars").setDisabled(false);
						}
					})
			);

		for (const calendar of caldav.calendars) {
			new Setting(containerEl)
				.setName(calendar.displayName)
				.setDesc(calendar.readOnly ? "Read-only on the server" : "Two-way")
				.addToggle((toggle) =>
					toggle.setValue(calendar.enabled).onChange(async (value) => {
						calendar.enabled = value;
						await this.plugin.saveSettings();
					})
				);
		}

		if (caldav.calendars.length > 0) {
			new Setting(containerEl)
				.setName("Default calendar")
				.setDesc(
					"Where events go when none of their types maps to a calendar. " +
						"Leave unset to keep such events in the vault only."
				)
				.addDropdown((dropdown) => {
					dropdown.addOption("", "Don't sync them");
					for (const calendar of caldav.calendars) {
						dropdown.addOption(calendar.url, calendar.displayName);
					}
					dropdown.setValue(caldav.fallbackCalendar);
					dropdown.onChange(async (value) => {
						caldav.fallbackCalendar = value;
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(containerEl)
			.setName("Sync every")
			.setDesc("Minutes between background syncs. Set to 0 to sync only on demand.")
			.addText((text) =>
				text
					.setValue(String(caldav.intervalMinutes))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (!isNaN(parsed) && parsed >= 0) {
							caldav.intervalMinutes = Math.round(parsed);
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc(
				caldav.lastSync
					? `Last synced ${new Date(caldav.lastSync).toLocaleString()}.`
					: "Never synced."
			)
			.addButton((button) =>
				button.setButtonText("Sync").onClick(async () => {
					button.setDisabled(true);
					await this.plugin.sync.run();
					button.setDisabled(false);
					this.display();
				})
			);
	}

	private renderType(containerEl: HTMLElement, type: EventType): void {
		const fieldSummary = type.fields.length
			? type.fields.map((field) => field.label).join(", ")
			: "no custom fields";
		const mapped = this.plugin.settings.caldav.calendars.find(
			(calendar) => calendar.url === type.icloudCalendar
		);

		new Setting(containerEl)
			.setName(type.label)
			.setDesc(
				`id: ${type.id} \u00b7 rank ${type.rank} \u00b7 ${fieldSummary}` +
					(mapped ? ` \u00b7 syncs to ${mapped.displayName}` : "")
			)
			.addText((text) =>
				text
					.setPlaceholder("Label")
					.setValue(type.label)
					.onChange(async (value) => {
						type.label = value;
						await this.plugin.saveSettings();
					})
			)
			.addColorPicker((picker) =>
				picker.setValue(type.color).onChange(async (value) => {
					type.color = value;
					await this.plugin.saveSettings();
				})
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("", "No calendar");
				for (const calendar of this.plugin.settings.caldav.calendars) {
					dropdown.addOption(calendar.url, calendar.displayName);
				}
				dropdown.setValue(type.icloudCalendar ?? "");
				dropdown.onChange(async (value) => {
					// Two types pointing at one calendar would make pulls
					// ambiguous, so the previous owner is cleared.
					if (value) {
						for (const other of this.plugin.settings.eventTypes) {
							if (other.id !== type.id && other.icloudCalendar === value) {
								delete other.icloudCalendar;
							}
						}
					}
					type.icloudCalendar = value || undefined;
					await this.plugin.saveSettings();
					this.display();
				});
			})
			.addExtraButton((button) =>
				button
					.setIcon("trash")
					.setTooltip("Delete type")
					.onClick(async () => {
						this.plugin.settings.eventTypes =
							this.plugin.settings.eventTypes.filter((t) => t.id !== type.id);
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// The fields of a type are edited often enough to need a real editor,
		// but not so often that they should crowd the list. A disclosure keeps
		// a dozen types readable while still being one click from editable.
		const details = containerEl.createEl("details", { cls: "tc-type-details" });
		details.createEl("summary", {
			text: type.fields.length
				? `Custom fields (${type.fields.length}) and rank`
				: "Custom fields and rank",
		});

		new Setting(details)
			.setName("Rank")
			.setDesc(
				"Higher ranks sort first in the priority view, and decide which " +
					"calendar an event with several mapped types is sent to."
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(type.rank)).onChange(async (value) => {
					const parsed = Number(value);
					if (!isNaN(parsed)) {
						type.rank = Math.round(parsed);
						await this.plugin.saveSettings();
					}
				});
			});

		for (const field of type.fields) {
			this.renderField(details, type, field);
		}

		new Setting(details)
			.setDesc(
				type.fields.length
					? "Fields appear in the event editor for any event carrying this type."
					: "Add a field an event of this type should record, like an exam's weight."
			)
			.addButton((button) =>
				button.setButtonText("Add field").onClick(async () => {
					type.fields.push({
						key: uniqueKey(type.fields, "field"),
						label: "New field",
						type: "text",
					});
					await this.plugin.saveSettings();
					this.display();
				})
			);
	}

	/**
	 * One custom field. `key` is what lands in an event's `props`, so renaming
	 * it does not carry existing values across -- said plainly rather than
	 * prevented, since the alternative is a field nobody can ever rename.
	 */
	private renderField(container: HTMLElement, type: EventType, field: TypeField): void {
		const setting = new Setting(container)
			.setName(`\u00b7 ${field.label || field.key}`)
			.setDesc(
				`props.${field.key}` +
					(field.showInPriority ? " \u00b7 shown in priority" : "") +
					(field.required ? " \u00b7 required" : "")
			);

		setting.addText((text) =>
			text
				.setPlaceholder("Label")
				.setValue(field.label)
				.onChange(async (value) => {
					field.label = value;
					await this.plugin.saveSettings();
				})
		);

		setting.addText((text) => {
			text.inputEl.addClass("tc-field-key");
			text
				.setPlaceholder("key")
				.setValue(field.key)
				.onChange(async (value) => {
					// The key becomes a YAML key under props, so keep it to
					// characters that need no quoting.
					const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "");
					if (cleaned !== value) text.setValue(cleaned);
					if (!cleaned) return;
					field.key = cleaned;
					await this.plugin.saveSettings();
				});
		});

		setting.addDropdown((dropdown) => {
			for (const [value, label] of Object.entries(FIELD_TYPES)) {
				dropdown.addOption(value, label);
			}
			dropdown.setValue(field.type);
			dropdown.onChange(async (value) => {
				field.type = value as FieldType;
				if (field.type !== "select") delete field.options;
				// Only a number can be compared, so the priority tie-break
				// silently ignores anything else marked as a weight.
				await this.plugin.saveSettings();
				this.display();
			});
		});

		setting.addExtraButton((button) =>
			button
				.setIcon("trash")
				.setTooltip("Delete field")
				.onClick(async () => {
					type.fields = type.fields.filter((candidate) => candidate !== field);
					await this.plugin.saveSettings();
					this.display();
				})
		);

		new Setting(container)
			.setName("Unit")
			.setDesc("Appended after the value in the priority view, e.g. %.")
			.addText((text) =>
				text
					.setPlaceholder("none")
					.setValue(field.unit ?? "")
					.onChange(async (value) => {
						field.unit = value.trim() || undefined;
						await this.plugin.saveSettings();
					})
			)
			.addToggle((toggle) =>
				toggle
					.setTooltip("Show in priority view")
					.setValue(field.showInPriority === true)
					.onChange(async (value) => {
						field.showInPriority = value || undefined;
						await this.plugin.saveSettings();
					})
			)
			.addToggle((toggle) =>
				toggle
					.setTooltip("Required: flagged in Expecting soon when empty")
					.setValue(field.required === true)
					.onChange(async (value) => {
						field.required = value || undefined;
						await this.plugin.saveSettings();
					})
			);

		if (field.type === "select") {
			new Setting(container)
				.setName("Choices")
				.setDesc("Comma-separated. These become the dropdown options in the event editor.")
				.addText((text) =>
					text
						.setPlaceholder("draft, submitted, graded")
						.setValue((field.options ?? []).join(", "))
						.onChange(async (value) => {
							const options = value
								.split(",")
								.map((option) => option.trim())
								.filter(Boolean);
							field.options = options.length > 0 ? options : undefined;
							await this.plugin.saveSettings();
						})
				);
		}
	}
}

/** Appends a numeric suffix until the key is free within the type. */
function uniqueKey(fields: TypeField[], base: string): string {
	const taken = new Set(fields.map((field) => field.key));
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}
