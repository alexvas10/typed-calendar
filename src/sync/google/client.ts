import { CalendarEvent, OccurrenceOverride } from "../../model/types";
import { davRequest } from "../http";
import { OAuthAccount } from "../account";
import { activeOverrides } from "../../model/occurrences";
import {
	RemoteCalendarInfo,
	RemoteItem,
	RemoteProvider,
	planOverrides,
	sameMaster,
	sameMirror,
	sameRepeat,
} from "../remote";
import {
	GoogleEvent,
	GoogleRaw,
	eventBody,
	occurrenceBody,
	originalStart,
	readEvents,
	readExdates,
} from "./mapping";
import { utcToWallClock } from "../../util/timezone";

const API = "https://www.googleapis.com/calendar/v3";

export class ProviderError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

/**
 * Google Calendar through its REST API (v3).
 *
 * Writes are PATCHes of the fields this plugin owns, never whole-event
 * replacements, so reminders, attendees, colours and conferencing set on the
 * phone survive every edit -- the same principle as patchICS for iCloud.
 */
export class GoogleProvider implements RemoteProvider {
	readonly key = "google" as const;
	readonly label = "Google";

	constructor(
		private account: OAuthAccount,
		/** Overridable so the client can be exercised against a local fake. */
		private api = API
	) {}

	private async call<T>(
		method: string,
		path: string,
		options: { query?: Record<string, string>; body?: unknown; retried?: boolean } = {}
	): Promise<T> {
		const url = new URL(`${this.api}${path}`);
		for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
		const response = await davRequest({
			url: url.toString(),
			method,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			headers: {
				Authorization: `Bearer ${await this.account.token(options.retried)}`,
				Accept: "application/json",
				...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
			},
		});
		// An access token revoked or expired early: refresh once and retry.
		if (response.status === 401 && !options.retried) {
			return this.call<T>(method, path, { ...options, retried: true });
		}
		if (response.status >= 300) {
			let message = response.text.slice(0, 200);
			try {
				message = JSON.parse(response.text)?.error?.message ?? message;
			} catch {
				// Keep the raw text.
			}
			throw new ProviderError(response.status, `Google ${method} ${path}: ${response.status} ${message}`);
		}
		return (response.text ? JSON.parse(response.text) : undefined) as T;
	}

	/** Follows nextPageToken until the list is complete. */
	private async all<T>(path: string, query: Record<string, string>): Promise<T[]> {
		const out: T[] = [];
		let pageToken: string | undefined;
		do {
			const page = await this.call<{ items?: T[]; nextPageToken?: string }>("GET", path, {
				query: pageToken ? { ...query, pageToken } : query,
			});
			out.push(...(page.items ?? []));
			pageToken = page.nextPageToken;
		} while (pageToken);
		return out;
	}

	async accountName(): Promise<string> {
		// The primary calendar's id is the account's address.
		const primary = await this.call<{ id: string }>("GET", "/users/me/calendarList/primary");
		return primary.id;
	}

	async listCalendars(): Promise<RemoteCalendarInfo[]> {
		const items = await this.all<{ id: string; summary?: string; summaryOverride?: string; accessRole?: string }>(
			"/users/me/calendarList",
			{ maxResults: "250" }
		);
		return items.map((item) => ({
			id: item.id,
			name: item.summaryOverride || item.summary || item.id,
			readOnly: item.accessRole !== "owner" && item.accessRole !== "writer",
		}));
	}

	async listEvents(calendarId: string, timezone: string): Promise<RemoteItem[]> {
		// singleEvents=false: masters with their rules, plus one record per
		// changed or cancelled occurrence -- not every occurrence expanded.
		const events = await this.all<GoogleEvent>(`/calendars/${encodeURIComponent(calendarId)}/events`, {
			maxResults: "2500",
			singleEvents: "false",
			showDeleted: "false",
		});
		return readEvents(events, timezone);
	}

	unsupported(): string | null {
		// Google stores RFC 5545 rules, so every rule the plugin can hold fits.
		return null;
	}

	async create(calendarId: string, event: CalendarEvent, timezone: string): Promise<string> {
		const created = await this.call<GoogleEvent>(
			"POST",
			`/calendars/${encodeURIComponent(calendarId)}/events`,
			{ body: eventBody(event, timezone) }
		);
		// Occurrence changes need the series to exist first. Only ones that
		// still apply: an entry for a date the rule no longer makes is inert.
		for (const override of event.recurrence ? activeOverrides(event) : []) {
			await this.writeOccurrence(calendarId, created.id, event, override.occurrence, override, timezone, []);
		}
		return created.id;
	}

	async update(calendarId: string, current: RemoteItem, event: CalendarEvent, timezone: string): Promise<boolean> {
		const remote = current.event;
		const raw = current.raw as GoogleRaw | undefined;
		// A series the plugin could not read, or a note that lost its rule: never
		// flatten a real series into one event (see patchICS).
		if (remote.recurring && !remote.recurrence) return false;
		if (remote.recurrence && !event.recurrence) return false;

		let changed = false;
		if (!sameMaster(remote, event) || !sameRepeat(remote, event, timezone) || !sameMirror(remote, event)) {
			await this.call("PATCH", eventPath(calendarId, current.id), { body: eventBody(event, timezone) });
			changed = true;
		}

		const instances = raw?.instances ?? [];
		// A date restored in the note that the phone had deleted as a cancelled
		// record: EXDATEs are rewritten above, but the record has to be revived.
		const skipped = new Set(event.exceptions ?? []);
		const exdates = new Set(readExdates(raw?.master.recurrence ?? [], timezone));
		for (const instance of instances) {
			if (instance.status !== "cancelled") continue;
			const occurrence = recordDate(instance, timezone);
			if (!occurrence || skipped.has(occurrence) || exdates.has(occurrence)) continue;
			await this.call("PATCH", eventPath(calendarId, instance.id), {
				body: { status: "confirmed", ...occurrenceBody(event, occurrence, undefined, timezone) },
			});
			changed = true;
		}

		const plan = planOverrides(remote, event);
		const overrides = wanted(event);
		for (const override of plan.write) {
			await this.writeOccurrence(calendarId, current.id, event, override.occurrence, override, timezone, instances);
			changed = true;
		}
		for (const occurrence of plan.reset) {
			// There is no "undo" for an occurrence record; putting it back in
			// line with the series is the equivalent.
			await this.writeOccurrence(calendarId, current.id, event, occurrence, overrides.get(occurrence), timezone, instances);
			changed = true;
		}
		return changed;
	}

	async move(from: string, to: string, current: RemoteItem, event: CalendarEvent, timezone: string): Promise<string> {
		// Google moves natively and keeps the id, occurrence records included.
		const moved = await this.call<GoogleEvent>("POST", `${eventPath(from, current.id)}/move`, {
			query: { destination: to },
		});
		await this.update(to, { ...current, id: moved.id }, event, timezone);
		return moved.id;
	}

	async delete(calendarId: string, id: string): Promise<void> {
		try {
			await this.call("DELETE", eventPath(calendarId, id));
		} catch (error) {
			// Already gone is the outcome we wanted.
			if (error instanceof ProviderError && (error.status === 404 || error.status === 410)) return;
			throw error;
		}
	}

	/** Patches one occurrence, finding its record first. */
	private async writeOccurrence(
		calendarId: string,
		masterId: string,
		event: CalendarEvent,
		occurrence: string,
		override: OccurrenceOverride | undefined,
		timezone: string,
		known: GoogleEvent[]
	): Promise<void> {
		let instanceId = known.find((i) => recordDate(i, timezone) === occurrence)?.id;
		if (!instanceId) {
			const found = await this.call<{ items?: GoogleEvent[] }>("GET", `${eventPath(calendarId, masterId)}/instances`, {
				query: { originalStart: originalStart(event, occurrence, timezone), showDeleted: "true" },
			});
			instanceId = found.items?.[0]?.id;
		}
		if (!instanceId) throw new Error(`Google has no occurrence of "${event.title}" on ${occurrence}.`);
		await this.call("PATCH", eventPath(calendarId, instanceId), {
			body: occurrenceBody(event, occurrence, override, timezone),
		});
	}
}

function eventPath(calendarId: string, eventId: string): string {
	return `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
}

function wanted(event: CalendarEvent): Map<string, OccurrenceOverride> {
	const out = new Map<string, OccurrenceOverride>();
	if (!event.recurrence) return out;
	for (const override of event.overrides ?? []) out.set(override.occurrence, override);
	return out;
}

/** The local date an occurrence record stands for. */
function recordDate(instance: GoogleEvent, timezone: string): string | null {
	const original = instance.originalStartTime;
	if (!original) return null;
	if (original.date) return original.date;
	const instant = original.dateTime ? Date.parse(original.dateTime) : NaN;
	return isNaN(instant) ? null : utcToWallClock(instant, timezone).date;
}
