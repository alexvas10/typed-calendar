import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TypedCalendarPlugin from "../../main";
import { CALENDAR_FIELD, EventType, FieldType, TypeField } from "../model/types";
import { autoMapCalendars } from "../sync/routing";
import { DeleteMode } from "./settings";

const FIELD_TYPES: Record<FieldType, string> = {
	text: "Text",
	number: "Number",
	date: "Date",
	select: "Choice",
	checkbox: "Checkbox",
};

export class TypedCalendarSettingTab extends PluginSettingTab {
	/**
	 * Folder and timezone edits typed but not yet applied; see
	 * `commitOnFinish`. Held here rather than written into the settings, so
	 * nothing reads a half-typed value in the meantime.
	 */
	private pending = new Map<string, () => void>();

	constructor(app: App, private plugin: TypedCalendarPlugin) {
		super(app, plugin);
	}

	/** Closing settings counts as finishing an edit. */
	hide(): void {
		void this.commitPending();
	}

	private async commitPending(): Promise<void> {
		if (this.pending.size === 0) return;
		for (const apply of this.pending.values()) apply();
		this.pending.clear();
		await this.plugin.saveSettings();
	}

	/** Queues `apply` for when the edit is finished, replacing an earlier one for `key`. */
	private defer(key: string, apply: () => void): void {
		this.pending.set(key, apply);
	}

	/**
	 * Saves a text field when the user finishes with it -- leaving the field,
	 * pressing Enter, or closing settings -- rather than on every key.
	 *
	 * For the folder this is not just tidiness: each save re-indexes the vault
	 * under the folder as typed so far and writes the agent docs into it, so
	 * typing "Calendar/Events" used to create folders "C", "Ca", "Cal", ...
	 */
	private commitOnFinish(input: HTMLInputElement): void {
		input.addEventListener("change", () => void this.commitPending());
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
					.onChange((value) => {
						this.defer("folder", () => {
							this.plugin.settings.eventFolder = value.replace(/^\/+|\/+$/g, "");
						});
					})
					.then((text) => this.commitOnFinish(text.inputEl))
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
					.onChange((value) => {
						// A half-typed zone ("America/To") must not be stamped onto an
						// event created meanwhile.
						this.defer("timezone", () => {
							this.plugin.settings.defaultTimezone = value.trim();
						});
					})
					.then((text) => this.commitOnFinish(text.inputEl))
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
		this.renderOAuthService(containerEl, "google");
		this.renderOAuthService(containerEl, "outlook");
		this.renderSyncGeneral(containerEl);

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
	}

	/**
	 * Google Calendar or Outlook: the app registration, sign-in, and which
	 * calendars take part. Sign-in uses the user's own registration for now;
	 * a built-in one for everyone is planned (see handoff.md).
	 */
	private renderOAuthService(containerEl: HTMLElement, key: "google" | "outlook"): void {
		const service = this.plugin.settings[key];
		const google = key === "google";
		const label = google ? "Google Calendar" : "Outlook";

		new Setting(containerEl).setName(`${label} sync`).setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description tc-settings-note",
			text: google
				? "Needs your own Google Cloud OAuth client (type: Desktop app) with the Google Calendar API " +
					"enabled; the README walks through it in a few minutes. Sign-in happens in your browser, " +
					"and the plugin never sees your password."
				: "Needs your own Azure app registration (platform: Mobile and desktop, redirect " +
					"http://localhost, accounts in any organization and personal Microsoft accounts); the README " +
					"walks through it. Sign-in happens in your browser, and the plugin never sees your password.",
		});

		new Setting(containerEl)
			.setName(google ? "OAuth client ID" : "Application (client) ID")
			.addText((text) =>
				text
					.setPlaceholder(google ? "…apps.googleusercontent.com" : "00000000-0000-0000-0000-000000000000")
					.setValue(service.clientId)
					.onChange(async (value) => {
						service.clientId = value.trim();
						await this.plugin.saveSettings();
					})
			);
		if (google) {
			new Setting(containerEl)
				.setName("OAuth client secret")
				.setDesc("Google's desktop clients have one; it is not a password.")
				.addText((text) => {
					text.inputEl.type = "password";
					text.setValue(service.clientSecret).onChange(async (value) => {
						service.clientSecret = value.trim();
						await this.plugin.saveSettings();
					});
				});
		}

		const account = new Setting(containerEl).setName("Account");
		if (service.tokens) {
			account.setDesc(service.account ? `Signed in as ${service.account}.` : "Signed in.");
			account.addButton((button) =>
				button.setButtonText("Sign out").onClick(async () => {
					await this.plugin.account(key).signOut();
					service.account = "";
					await this.plugin.saveSettings();
					this.display();
				})
			);
		} else {
			account.setDesc(
				service.clientId ? "Not signed in." : `Add the ${google ? "client ID and secret" : "client ID"} first.`
			);
			account.addButton((button) =>
				button
					.setButtonText("Sign in")
					.setCta()
					.setDisabled(!service.clientId || (google && !service.clientSecret))
					.onClick(async () => {
						button.setButtonText("Waiting for the browser…").setDisabled(true);
						try {
							await this.plugin.account(key).signIn((url) => window.open(url));
							service.account = await this.plugin.provider(key).accountName().catch(() => "");
							await this.plugin.saveSettings();
							new Notice(`Signed in to ${label}${service.account ? ` as ${service.account}` : ""}.`);
						} catch (error) {
							new Notice((error as Error).message);
						}
						this.display();
					})
			);
		}
		if (!service.tokens) return;

		new Setting(containerEl)
			.setName("Calendars")
			.setDesc(
				service.calendars.length > 0
					? "Toggle which calendars take part in sync. Enabling one copies every event that routes there into it."
					: "Find the calendars on this account."
			)
			.addButton((button) =>
				button
					.setButtonText("Discover calendars")
					.setCta()
					.onClick(async () => {
						button.setButtonText("Discovering…").setDisabled(true);
						try {
							const found = await this.plugin.provider(key).listCalendars();
							const previous = new Map(service.calendars.map((c) => [c.url, c.enabled]));
							service.calendars = found.map((calendar) => ({
								url: calendar.id,
								displayName: calendar.name,
								readOnly: calendar.readOnly,
								enabled: previous.get(calendar.id) ?? false,
							}));
							const mapped = autoMapCalendars(
								this.plugin.settings.eventTypes,
								service.calendars,
								CALENDAR_FIELD[key]
							);
							this.plugin.settings.eventTypes = mapped.types;
							await this.plugin.saveSettings();
							new Notice(
								`Found ${found.length} calendar(s).\n` +
									(mapped.mappings.length ? mapped.mappings.join("\n") : "No new mappings.")
							);
						} catch (error) {
							new Notice(`Discovery failed: ${(error as Error).message}`);
						}
						this.display();
					})
			);

		for (const calendar of service.calendars) {
			new Setting(containerEl)
				.setName(calendar.displayName)
				.setDesc(calendar.readOnly ? "Read-only for this account" : "Two-way")
				.addToggle((toggle) =>
					toggle.setValue(calendar.enabled).onChange(async (value) => {
						calendar.enabled = value;
						await this.plugin.saveSettings();
					})
				);
		}

		if (service.calendars.length > 0) {
			new Setting(containerEl)
				.setName("Default calendar")
				.setDesc("Where events go when none of their types maps to a calendar here.")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "Don't sync them");
					for (const calendar of service.calendars) dropdown.addOption(calendar.url, calendar.displayName);
					dropdown.setValue(service.fallbackCalendar);
					dropdown.onChange(async (value) => {
						service.fallbackCalendar = value;
						await this.plugin.saveSettings();
					});
				});
		}
	}

	/** Settings that apply to every service. */
	private renderSyncGeneral(containerEl: HTMLElement): void {
		const { caldav } = this.plugin.settings;
		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("When an event is deleted in one calendar")
			.setDesc(
				"Deleting from Obsidian always removes an event everywhere. This decides what a deletion " +
					"made on a phone or in a calendar app does to the other copies."
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("this-calendar", "Remove it from that calendar only");
				dropdown.addOption("everywhere", "Delete it everywhere");
				dropdown.setValue(this.plugin.settings.deleteMode);
				dropdown.onChange(async (value) => {
					this.plugin.settings.deleteMode = value as DeleteMode;
					await this.plugin.saveSettings();
				});
			});

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

		// iCloud's picker sits in the row above, since it came first; the other
		// services appear here once they have calendars to choose from.
		for (const key of ["google", "outlook"] as const) {
			const calendars = this.plugin.settings[key].calendars;
			if (calendars.length === 0) continue;
			const field = CALENDAR_FIELD[key];
			new Setting(details)
				.setName(key === "google" ? "Google calendar" : "Outlook calendar")
				.setDesc("Where events of this type go on that service.")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "No calendar");
					for (const calendar of calendars) dropdown.addOption(calendar.url, calendar.displayName);
					dropdown.setValue(type[field] ?? "");
					dropdown.onChange(async (value) => {
						// One type per calendar, as for iCloud.
						if (value) {
							for (const other of this.plugin.settings.eventTypes) {
								if (other.id !== type.id && other[field] === value) delete other[field];
							}
						}
						type[field] = value || undefined;
						await this.plugin.saveSettings();
					});
				});
		}

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
