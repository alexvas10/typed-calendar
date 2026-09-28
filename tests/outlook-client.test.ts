import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { OutlookProvider } from "../src/sync/outlook/client";
import { OAuthAccount } from "../src/sync/account";
import { fromPattern, type GraphEvent } from "../src/sync/outlook/mapping";
import { expandOccurrences } from "../src/model/recurrence";
import { planOverrides, sameMaster, sameMirror, sameRepeat } from "../src/sync/remote";
import type { CalendarEvent } from "../src/model/types";

const TO = "America/Toronto";

/**
 * A small Microsoft Graph calendar on localhost. Faithful where the client
 * depends on it: /instances lists occurrences (deleted ones missing, changed
 * ones as exceptions); patching an occurrence makes it an exception; deleting
 * one removes it for good; and changing a series' pattern drops its
 * exceptions and deletions, as Outlook does.
 */
class FakeGraph {
	events = new Map<string, GraphEvent & { calendar: string }>();
	exceptions = new Map<string, Map<string, GraphEvent>>();
	deleted = new Map<string, Set<string>>();
	requests: string[] = [];
	private n = 1;
	server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const url = new URL(req.url!, "http://x");
			const path = url.pathname.replace("/v1.0", "");
			this.requests.push(`${req.method} ${path}`);
			const reply = (status: number, value?: unknown) =>
				res.writeHead(status, { "Content-Type": "application/json" }).end(value === undefined ? "" : JSON.stringify(value));
			const data = body ? JSON.parse(body) : undefined;
			const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
			if (path === "/me") return reply(200, { mail: "me@example.com" });
			if (parts[1] === "calendars" && parts.length === 2) return reply(200, { value: [{ id: "cal-a", name: "A", canEdit: true }, { id: "cal-b", name: "B", canEdit: true }] });
			if (parts[1] === "calendars" && req.method === "GET") {
				return reply(200, { value: [...this.events.values()].filter((e) => e.calendar === parts[2]) });
			}
			if (parts[1] === "calendars" && req.method === "POST") {
				const id = `ev${this.n++}`;
				const event = { ...data, id, calendar: parts[2], changeKey: `ck${this.n}`,
					type: data.recurrence ? "seriesMaster" : "singleInstance", lastModifiedDateTime: this.now() };
				this.events.set(id, event);
				return reply(201, event);
			}
			const id = parts[2];
			if (parts[3] === "instances") return reply(200, { value: this.instances(id, url) });
			const [masterId, date] = id.split("_");
			if (req.method === "PATCH") {
				if (date) {
					const base = this.occurrence(masterId, date);
					const map = this.exceptions.get(masterId) ?? new Map();
					map.set(date, { ...base, ...(map.get(date) ?? {}), ...data, type: "exception", changeKey: `ck${this.n++}` });
					this.exceptions.set(masterId, map);
					this.touch(masterId);
				} else {
					const before = JSON.stringify([this.events.get(id)!.recurrence, this.events.get(id)!.start]);
					this.events.set(id, { ...this.events.get(id)!, ...data, changeKey: `ck${this.n++}`, lastModifiedDateTime: this.now() });
					if (before !== JSON.stringify([data.recurrence ?? this.events.get(id)!.recurrence, data.start ?? this.events.get(id)!.start])) {
						// Outlook: a new pattern or start resets the series' exceptions.
						this.exceptions.delete(id);
						this.deleted.delete(id);
					}
				}
				return reply(200, {});
			}
			if (req.method === "DELETE") {
				if (date) {
					const set = this.deleted.get(masterId) ?? new Set();
					set.add(date);
					this.deleted.set(masterId, set);
					this.exceptions.get(masterId)?.delete(date);
					this.touch(masterId);
				} else if (!this.events.delete(id)) return reply(404, { error: { message: "gone" } });
				return reply(204);
			}
			reply(404, { error: { message: `no route ${path}` } });
		});
	});
	private now(): string {
		return new Date(Date.now() + this.n * 1000).toISOString();
	}
	private touch(masterId: string): void {
		const master = this.events.get(masterId)!;
		this.events.set(masterId, { ...master, lastModifiedDateTime: this.now() });
	}
	private occurrence(masterId: string, date: string): GraphEvent {
		const master = this.events.get(masterId)!;
		const shift = (t: { dateTime: string; timeZone: string }) => ({ ...t, dateTime: `${date}${t.dateTime.slice(10)}` });
		return { id: `${masterId}_${date}`, type: "occurrence", subject: master.subject, location: master.location,
			body: master.body, isAllDay: master.isAllDay, start: shift(master.start!), end: shift(master.end!),
			originalStart: `${date}T15:00:00Z` };
	}
	private instances(masterId: string, url: URL): GraphEvent[] {
		const master = this.events.get(masterId)!;
		const start = master.start!.dateTime.slice(0, 10);
		const rule = fromPattern(master.recurrence!.pattern, master.recurrence!.range, start)!;
		const window = { from: url.searchParams.get("startDateTime")!.slice(0, 10), to: url.searchParams.get("endDateTime")!.slice(0, 10) };
		const dates = expandOccurrences(start, rule, [], window).filter((d) => d < window.to || window.from === window.to);
		return dates
			.filter((d) => !this.deleted.get(masterId)?.has(d))
			.map((d) => this.exceptions.get(masterId)?.get(d) ?? this.occurrence(masterId, d));
	}
}

async function withFake(run: (outlook: OutlookProvider, fake: FakeGraph) => Promise<void>): Promise<void> {
	const fake = new FakeGraph();
	await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
	const port = (fake.server.address() as { port: number }).port;
	const account = new OAuthAccount(
		{ label: "Outlook", authorizeUrl: "", tokenUrl: "", clientId: "", scopes: [], redirectHost: "localhost" },
		() => ({ accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000 }),
		async () => {}
	);
	try {
		await run(new OutlookProvider(account, `http://127.0.0.1:${port}/v1.0`), fake);
	} finally {
		fake.server.close();
	}
}

const lecture = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
	uid: "evt-lec", title: "Lecture", types: ["class"], date: "2026-02-04", startTime: "10:00", endTime: "11:20",
	allDay: false, location: "MC 4021", timezone: TO, status: "confirmed", props: {}, path: "lec.md",
	recurrence: { freq: "weekly", interval: 1, byDay: ["WE"], until: "2026-02-25" },
	exceptions: ["2026-02-11"],
	overrides: [{ occurrence: "2026-02-18", date: "2026-02-19", startTime: "14:00", endTime: "15:20", location: "DC 1350" }],
	...over,
});

function agrees(remote: Parameters<typeof sameMaster>[0], note: CalendarEvent): void {
	assert.ok(sameMaster(remote, note), `fields: ${JSON.stringify(remote)}`);
	assert.ok(sameRepeat(remote, note, TO), `rule/skips: ${JSON.stringify([remote.recurrence, remote.exceptions])}`);
	assert.ok(sameMirror(remote, note), "types/fields");
	assert.deepEqual(planOverrides(remote, note), { write: [], reset: [] }, "occurrences");
}

test("a series with a deleted week and a moved week is created, and reads back identical", () =>
	withFake(async (outlook) => {
		await outlook.create("cal-a", lecture(), TO);
		const [item] = await outlook.listEvents("cal-a", TO);
		assert.equal(item.event.uid, "evt-lec");
		agrees(item.event, lecture());
	}));

test("an unchanged series costs no write", () =>
	withFake(async (outlook, fake) => {
		await outlook.create("cal-a", lecture(), TO);
		const [item] = await outlook.listEvents("cal-a", TO);
		fake.requests = [];
		assert.equal(await outlook.update("cal-a", item, lecture(), TO), false);
		assert.deepEqual(fake.requests.filter((r) => !r.startsWith("GET")), []);
	}));

test("changing the pattern, which makes Outlook drop exceptions, writes them all again", () =>
	withFake(async (outlook) => {
		await outlook.create("cal-a", lecture(), TO);
		const [item] = await outlook.listEvents("cal-a", TO);
		const shorter = lecture({ recurrence: { freq: "weekly", interval: 1, byDay: ["WE"], until: "2026-02-18" } });
		assert.equal(await outlook.update("cal-a", item, shorter, TO), true);
		const [after] = await outlook.listEvents("cal-a", TO);
		agrees(after.event, shorter);
	}));

test("skipping another week in the note deletes just that occurrence", () =>
	withFake(async (outlook, fake) => {
		await outlook.create("cal-a", lecture(), TO);
		const [item] = await outlook.listEvents("cal-a", TO);
		const more = lecture({ exceptions: ["2026-02-11", "2026-02-25"] });
		fake.requests = [];
		await outlook.update("cal-a", item, more, TO);
		assert.equal(fake.requests.filter((r) => r.startsWith("DELETE")).length, 1);
		agrees((await outlook.listEvents("cal-a", TO))[0].event, more);
	}));

test("reset to series settles, and a restored deleted week stays deleted (Graph cannot undo it)", () =>
	withFake(async (outlook) => {
		await outlook.create("cal-a", lecture(), TO);
		const [item] = await outlook.listEvents("cal-a", TO);
		const reset = lecture({ overrides: undefined, exceptions: [] });
		await outlook.update("cal-a", item, reset, TO);
		const [after] = await outlook.listEvents("cal-a", TO);
		assert.equal(after.event.overrides, undefined, "the moved week is back in line");
		assert.deepEqual(after.event.exceptions, ["2026-02-11"], "the documented limitation");
		assert.equal(await outlook.update("cal-a", after, lecture({ overrides: undefined }), TO), false,
			"and once the note agrees, nothing repeats");
	}));

test("rules Outlook cannot hold are refused before anything is written", () =>
	withFake(async (outlook) => {
		assert.match(outlook.unsupported(lecture({ recurrence: { freq: "monthly", interval: 1, byMonthDay: [1, 15] } }))!, /one day/);
		assert.equal(outlook.unsupported(lecture()), null);
	}));

test("a move is a new event in the destination and none in the source", () =>
	withFake(async (outlook, fake) => {
		await outlook.create("cal-a", lecture(), TO);
		const [item] = await outlook.listEvents("cal-a", TO);
		const id = await outlook.move("cal-a", "cal-b", item, lecture(), TO);
		assert.notEqual(id, item.id);
		assert.deepEqual(await outlook.listEvents("cal-a", TO), []);
		agrees((await outlook.listEvents("cal-b", TO))[0].event, lecture());
		void fake;
	}));

test("the account name comes from /me", () =>
	withFake(async (outlook) => {
		assert.equal(await outlook.accountName(), "me@example.com");
	}));
