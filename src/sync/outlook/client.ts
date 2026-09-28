import { CalendarEvent, OccurrenceOverride } from "../../model/types";
import { davRequest } from "../http";
import { OAuthAccount } from "../account";
import { ProviderError } from "../google/client";
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
	EXPAND_PROPERTIES,
	GraphEvent,
	eventBody,
	occurrenceBody,
	occurrenceWindow,
	outlookRuleProblem,
	readEvent,
} from "./mapping";
import { addDays, startOfToday, toDateString } from "../../util/dates";
import { activeOverrides } from "../../model/occurrences";

const API = "https://graph.microsoft.com/v1.0";

/** Only what the reader needs, so a big calendar is not a big download. */
const SELECT = [
	"id", "changeKey", "type", "subject", "body", "location", "start", "end", "isAllDay",
	"isCancelled", "recurrence", "originalStart", "seriesMasterId", "lastModifiedDateTime", "iCalUId",
].join(",");

/**
 * Outlook (Microsoft 365 and Outlook.com) through Microsoft Graph.
 *
 * Differences from Google that shape this client:
 * - Graph lists a series' occurrences, not its exceptions, so each series
 *   costs one extra request to read which weeks were moved or deleted.
 * - A deleted occurrence cannot be brought back through the API. Restoring a
 *   skipped date in the note therefore does not reach Outlook; it is logged.
 * - There is no move between calendars: a move is a create in the
 *   destination followed by a delete of the source.
 */
export class OutlookProvider implements RemoteProvider {
	readonly key = "outlook" as const;
	readonly label = "Outlook";

	constructor(
		private account: OAuthAccount,
		/** Overridable so the client can be exercised against a local fake. */
		private api = API
	) {}

	private async call<T>(
		method: string,
		pathOrUrl: string,
		options: { query?: Record<string, string>; body?: unknown; timezone?: string; retried?: boolean } = {}
	): Promise<T> {
		const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${this.api}${pathOrUrl}`);
		for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
		const prefer = ['outlook.body-content-type="text"'];
		// Times come back as wall clock in the user's zone, so reading needs no
		// conversion and an all-day event keeps its date.
		if (options.timezone) prefer.push(`outlook.timezone="${options.timezone}"`);
		const response = await davRequest({
			url: url.toString(),
			method,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			headers: {
				Authorization: `Bearer ${await this.account.token(options.retried)}`,
				Accept: "application/json",
				Prefer: prefer.join(", "),
				...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
			},
		});
		if (response.status === 401 && !options.retried) {
			return this.call<T>(method, pathOrUrl, { ...options, retried: true });
		}
		if (response.status >= 300) {
			let message = response.text.slice(0, 200);
			try {
				message = JSON.parse(response.text)?.error?.message ?? message;
			} catch {
				// Keep the raw text.
			}
			throw new ProviderError(response.status, `Outlook ${method} ${url.pathname}: ${response.status} ${message}`);
		}
		return (response.text ? JSON.parse(response.text) : undefined) as T;
	}

	/** Follows @odata.nextLink until the list is complete. */
	private async all<T>(path: string, query: Record<string, string>, timezone?: string): Promise<T[]> {
		const out: T[] = [];
		let next: string | undefined = path;
		let first = true;
		while (next) {
			const page: { value?: T[]; "@odata.nextLink"?: string } = await this.call(
				"GET",
				next,
				{ query: first ? query : undefined, timezone }
			);
			out.push(...(page.value ?? []));
			next = page["@odata.nextLink"];
			first = false;
		}
		return out;
	}

	async accountName(): Promise<string> {
		const me = await this.call<{ mail?: string; userPrincipalName?: string }>("GET", "/me", {
			query: { $select: "mail,userPrincipalName" },
		});
		return me.mail || me.userPrincipalName || "";
	}

	async listCalendars(): Promise<RemoteCalendarInfo[]> {
		const calendars = await this.all<{ id: string; name?: string; canEdit?: boolean }>("/me/calendars", {
			$select: "id,name,canEdit",
			$top: "100",
		});
		return calendars.map((c) => ({ id: c.id, name: c.name ?? c.id, readOnly: c.canEdit === false }));
	}

	async listEvents(calendarId: string, timezone: string): Promise<RemoteItem[]> {
		const events = await this.all<GraphEvent>(
			`/me/calendars/${encodeURIComponent(calendarId)}/events`,
			{ $select: SELECT, $expand: EXPAND_PROPERTIES, $top: "100" },
			timezone
		);
		const today = toDateString(startOfToday());
		const items: RemoteItem[] = [];
		for (const event of events) {
			if (event.isCancelled || event.type === "occurrence" || event.type === "exception") continue;
			let instances: GraphEvent[] = [];
			let window = { from: today, to: today };
			if (event.type === "seriesMaster" && event.start) {
				const start = event.start.dateTime.slice(0, 10);
				// The window comes from the rule as read, before instances.
				const draft = readEvent(event, [], { from: start, to: start });
				window = occurrenceWindow(start, draft?.event.recurrence, today);
				instances = await this.instances(event.id, window, timezone);
			}
			const item = readEvent(event, instances, window);
			if (item) items.push(item);
		}
		return items;
	}

	/** A series' occurrences (and changed ones) over a window. */
	private instances(masterId: string, window: { from: string; to: string }, timezone: string): Promise<GraphEvent[]> {
		return this.all<GraphEvent>(
			`/me/events/${encodeURIComponent(masterId)}/instances`,
			{
				startDateTime: `${window.from}T00:00:00`,
				endDateTime: `${addDays(window.to, 1)}T00:00:00`,
				$select: "id,changeKey,type,subject,body,location,start,end,isAllDay,originalStart",
				$top: "200",
			},
			timezone
		);
	}

	unsupported(event: CalendarEvent): string | null {
		return event.recurrence ? outlookRuleProblem(event.recurrence) : null;
	}

	async create(calendarId: string, event: CalendarEvent, timezone: string): Promise<string> {
		const created = await this.call<GraphEvent>(
			"POST",
			`/me/calendars/${encodeURIComponent(calendarId)}/events`,
			{ body: eventBody(event, timezone), timezone }
		);
		if (event.recurrence) {
			const write = new Map(activeOverrides(event).map((o) => [o.occurrence, o]));
			await this.applyOccurrences(created.id, event, timezone, [], new Set(), write, []);
		}
		return created.id;
	}

	async update(calendarId: string, current: RemoteItem, event: CalendarEvent, timezone: string): Promise<boolean> {
		const remote = current.event;
		if (remote.recurring && !remote.recurrence) return false;
		if (remote.recurrence && !event.recurrence) return false;

		let changed = false;
		const repeatChanged = !sameRepeat({ ...remote, exceptions: [] }, { ...event, exceptions: [] }, timezone);
		const timingChanged = !sameMaster(remote, event);
		if (timingChanged || repeatChanged || !sameMirror(remote, event)) {
			await this.call("PATCH", `/me/events/${encodeURIComponent(current.id)}`, {
				body: eventBody(event, timezone),
				timezone,
			});
			changed = true;
		}
		if (!event.recurrence) return changed;

		// Changing a series' pattern or time makes Outlook drop its changed and
		// deleted occurrences, so after either every one is written again.
		const fresh = repeatChanged || (timingChanged && remote.startTime !== event.startTime);
		const remoteSkipped = fresh ? new Set<string>() : new Set(remote.exceptions ?? []);
		const plan = fresh
			? { write: activeOverrides(event), reset: [] as string[] }
			: planOverrides(remote, event);
		const instances = fresh ? [] : ((current.raw as { instances?: GraphEvent[] })?.instances ?? []);
		if (await this.applyOccurrences(current.id, event, timezone, instances, remoteSkipped, new Map(plan.write.map((o) => [o.occurrence, o])), plan.reset)) {
			changed = true;
		}
		return changed;
	}

	/**
	 * Deletes newly skipped dates and writes changed occurrences. Returns
	 * whether anything was written.
	 */
	private async applyOccurrences(
		masterId: string,
		event: CalendarEvent,
		timezone: string,
		known: GraphEvent[],
		remoteSkipped: Set<string>,
		write: Map<string, OccurrenceOverride>,
		reset: string[]
	): Promise<boolean> {
		let changed = false;
		const find = async (date: string) =>
			known.find((i) => (i.originalStart?.slice(0, 10) ?? i.start?.dateTime.slice(0, 10)) === date)?.id ??
			(await this.instances(masterId, { from: date, to: date }, timezone)).find(
				(i) => (i.originalStart?.slice(0, 10) ?? i.start?.dateTime.slice(0, 10)) === date
			)?.id;

		const skipped = new Set(event.exceptions ?? []);
		for (const date of skipped) {
			if (remoteSkipped.has(date)) continue;
			const id = await find(date);
			if (!id) continue;
			await this.call("DELETE", `/me/events/${encodeURIComponent(id)}`);
			changed = true;
		}
		for (const date of remoteSkipped) {
			if (!skipped.has(date)) {
				// Graph has no way to undo a deleted occurrence.
				console.warn(`Typed Calendar: Outlook cannot restore the deleted ${date} occurrence of "${event.title}".`);
			}
		}
		const overrides = wanted(event);
		for (const date of [...write.keys(), ...reset]) {
			if (skipped.has(date)) continue;
			const id = await find(date);
			if (!id) throw new Error(`Outlook has no occurrence of "${event.title}" on ${date}.`);
			await this.call("PATCH", `/me/events/${encodeURIComponent(id)}`, {
				body: occurrenceBody(event, date, overrides.get(date), timezone),
				timezone,
			});
			changed = true;
		}
		return changed;
	}

	async move(from: string, to: string, current: RemoteItem, event: CalendarEvent, timezone: string): Promise<string> {
		// No move in Graph. Create first: unlike iCloud, Outlook does not refuse
		// a second copy, so a failed delete leaves a duplicate rather than a
		// lost event.
		const id = await this.create(to, event, timezone);
		await this.delete(from, current.id);
		return id;
	}

	async delete(_calendarId: string, id: string): Promise<void> {
		try {
			await this.call("DELETE", `/me/events/${encodeURIComponent(id)}`);
		} catch (error) {
			if (error instanceof ProviderError && (error.status === 404 || error.status === 410)) return;
			throw error;
		}
	}
}

function wanted(event: CalendarEvent): Map<string, OccurrenceOverride> {
	const out = new Map<string, OccurrenceOverride>();
	if (!event.recurrence) return out;
	for (const override of event.overrides ?? []) out.set(override.occurrence, override);
	return out;
}
