import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { GoogleProvider } from "../src/sync/google/client";
import { OAuthAccount } from "../src/sync/account";
import type { GoogleEvent } from "../src/sync/google/mapping";
import { planOverrides, sameMaster, sameMirror, sameRepeat } from "../src/sync/remote";
import type { CalendarEvent } from "../src/model/types";
import { toWallClock, utcOffsetMinutes, wallClockToUtc } from "../src/util/timezone";

const TO = "America/Toronto";

/**
 * A small Google Calendar v3 on localhost. Faithful where the client depends
 * on it: occurrence records exist only once patched, cancelled ones stay as
 * records, patches merge, moves keep the id, every change bumps the etag.
 */
class FakeGoogle {
	calendars = new Map<string, Map<string, GoogleEvent>>([["cal-a", new Map()], ["cal-b", new Map()]]);
	requests: string[] = [];
	private version = 1;
	server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const url = new URL(req.url!, "http://x");
			this.requests.push(`${req.method} ${url.pathname.replace("/calendar/v3", "")}`);
			const reply = (status: number, value?: unknown) =>
				res.writeHead(status, { "Content-Type": "application/json" }).end(value === undefined ? "" : JSON.stringify(value));
			const parts = url.pathname.replace("/calendar/v3/", "").split("/").map(decodeURIComponent);
			const data = body ? JSON.parse(body) : undefined;
			if (parts[0] === "users") return reply(200, { id: "me@example.com", items: [...this.calendars.keys()].map((id) => ({ id, summary: id, accessRole: "owner" })) });
			const cal = this.calendars.get(parts[1])!;
			const id = parts[3];
			if (parts.length === 3 && req.method === "GET") return reply(200, { items: [...cal.values()] });
			if (parts.length === 3 && req.method === "POST") {
				const event = this.stamp({ ...data, id: `ev${this.version}`, status: "confirmed" });
				cal.set(event.id, event);
				return reply(200, event);
			}
			if (parts[4] === "instances") {
				// A virtual occurrence: Google's id is master_start, a record only once patched.
				const start = url.searchParams.get("originalStart")!;
				const compact = start.length === 10 ? start.replace(/-/g, "") : start.replace(/[-:]/g, "").replace(/\.\d+/, "");
				return reply(200, { items: [{ id: `${id}_${compact}`, recurringEventId: id, originalStartTime: start.length === 10 ? { date: start } : { dateTime: start } }] });
			}
			if (parts[4] === "move") {
				const event = cal.get(id)!;
				const to = this.calendars.get(url.searchParams.get("destination")!)!;
				for (const [key, value] of cal) if (key === id || value.recurringEventId === id) { cal.delete(key); to.set(key, value); }
				return reply(200, this.stamp(event));
			}
			if (req.method === "PATCH") {
				let event = cal.get(id);
				if (!event) {
					// First patch of a virtual occurrence creates its record.
					const [master, stamp] = id.split("_");
					const iso = stamp.length === 8 ? undefined : `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
					event = { id, recurringEventId: master, status: "confirmed",
						originalStartTime: iso ? { dateTime: iso } : { date: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` } };
				}
				const merged = { ...event, ...data,
					extendedProperties: { private: { ...event.extendedProperties?.private, ...data.extendedProperties?.private } } };
				cal.set(id, this.stamp(withOffsets(merged)));
				return reply(200, cal.get(id));
			}
			if (req.method === "DELETE") { cal.delete(id); return reply(204); }
			reply(404, { error: { message: "no route" } });
		});
	});
	private stamp(event: GoogleEvent): GoogleEvent {
		this.version++;
		return withOffsets({ ...event, etag: `"${this.version}"`, updated: new Date(Date.now() + this.version * 1000).toISOString() });
	}
}

/** Google answers with offsets, not the bare wall time plus zone it was sent. */
function withOffsets(event: GoogleEvent): GoogleEvent {
	const fix = (t?: { date?: string; dateTime?: string; timeZone?: string }) => {
		if (!t?.dateTime || /[Z+-]\d\d:\d\d$|Z$/.test(t.dateTime)) return t;
		const [date, time] = t.dateTime.split("T");
		const zone = t.timeZone ?? TO;
		const minutes = utcOffsetMinutes(wallClockToUtc(toWallClock(date, time.slice(0, 5))!, zone), zone);
		const abs = Math.abs(minutes);
		const offset = `${minutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
		return { ...t, dateTime: `${date}T${time.slice(0, 8)}${offset}` };
	};
	return { ...event, start: fix(event.start), end: fix(event.end) };
}

async function withFake(run: (google: GoogleProvider, fake: FakeGoogle) => Promise<void>): Promise<void> {
	const fake = new FakeGoogle();
	await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
	const port = (fake.server.address() as { port: number }).port;
	const account = new OAuthAccount(
		{ label: "Google", authorizeUrl: "", tokenUrl: "", clientId: "", scopes: [], redirectHost: "127.0.0.1" },
		() => ({ accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000 }),
		async () => {}
	);
	try {
		await run(new GoogleProvider(account, `http://127.0.0.1:${port}/calendar/v3`), fake);
	} finally {
		fake.server.close();
	}
}

const lecture = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
	uid: "evt-lec", title: "Lecture", types: ["class"], date: "2026-02-04", startTime: "10:00", endTime: "11:20",
	allDay: false, location: "MC 4021", timezone: TO, status: "confirmed", props: { course: "CS 3600" }, path: "lec.md",
	recurrence: { freq: "weekly", interval: 1, byDay: ["WE"], until: "2026-02-25" },
	exceptions: ["2026-02-11"],
	overrides: [{ occurrence: "2026-02-18", date: "2026-02-19", startTime: "14:00", endTime: "15:20", location: "DC 1350" }],
	...over,
});

/** The service's copy agrees with the note in every part the plugin syncs. */
function agrees(remote: Parameters<typeof sameMaster>[0], note: CalendarEvent): void {
	assert.ok(sameMaster(remote, note), `fields: ${JSON.stringify(remote)}`);
	assert.ok(sameRepeat(remote, note, TO), `rule/skips: ${JSON.stringify([remote.recurrence, remote.exceptions])}`);
	assert.ok(sameMirror(remote, note), "types/fields");
	assert.deepEqual(planOverrides(remote, note), { write: [], reset: [] }, "occurrences");
}

test("a series with a skip and a moved week is created, and reads back identical", () =>
	withFake(async (google, fake) => {
		const id = await google.create("cal-a", lecture(), TO);
		const [item] = await google.listEvents("cal-a", TO);
		assert.equal(item.id, id);
		assert.equal(item.event.uid, "evt-lec");
		agrees(item.event, lecture());
		const records = [...fake.calendars.get("cal-a")!.values()].filter((e) => e.recurringEventId);
		assert.equal(records.length, 1, "only the moved week gets a record");
	}));

test("an unchanged event costs no write at all", () =>
	withFake(async (google, fake) => {
		await google.create("cal-a", lecture(), TO);
		const [item] = await google.listEvents("cal-a", TO);
		fake.requests = [];
		assert.equal(await google.update("cal-a", item, lecture(), TO), false);
		assert.deepEqual(fake.requests.filter((r) => !r.startsWith("GET")), []);
	}));

test("renaming the series reaches the moved week, which keeps its own room", () =>
	withFake(async (google) => {
		await google.create("cal-a", lecture(), TO);
		const [item] = await google.listEvents("cal-a", TO);
		const renamed = lecture({ title: "CS 3600 Lecture" });
		assert.equal(await google.update("cal-a", item, renamed, TO), true);
		const [after] = await google.listEvents("cal-a", TO);
		agrees(after.event, renamed);
		assert.equal(after.event.overrides?.[0].location, "DC 1350");
	}));

test("reset to series settles in one sync instead of repeating forever", () =>
	withFake(async (google, fake) => {
		await google.create("cal-a", lecture(), TO);
		const [item] = await google.listEvents("cal-a", TO);
		const reset = lecture({ overrides: undefined });
		assert.equal(await google.update("cal-a", item, reset, TO), true);
		const [after] = await google.listEvents("cal-a", TO);
		agrees(after.event, reset);
		fake.requests = [];
		assert.equal(await google.update("cal-a", after, reset, TO), false, "the leftover record is not a change");
	}));

test("a week deleted on the phone reads as skipped, and restoring it in the note brings it back", () =>
	withFake(async (google, fake) => {
		await google.create("cal-a", lecture({ overrides: undefined }), TO);
		// The phone deletes 25 Feb: Google records it as a cancelled occurrence.
		const cal = fake.calendars.get("cal-a")!;
		const master = [...cal.values()][0];
		cal.set(`${master.id}_20260225T150000Z`, { id: `${master.id}_20260225T150000Z`, recurringEventId: master.id,
			status: "cancelled", etag: '"x"', originalStartTime: { dateTime: "2026-02-25T15:00:00Z" } });
		const [item] = await google.listEvents("cal-a", TO);
		assert.deepEqual(item.event.exceptions, ["2026-02-11", "2026-02-25"]);

		// The note restores it (only 11 Feb stays skipped).
		const restored = lecture({ overrides: undefined });
		await google.update("cal-a", item, restored, TO);
		const [after] = await google.listEvents("cal-a", TO);
		assert.deepEqual(after.event.exceptions, ["2026-02-11"]);
	}));

test("a move keeps the event's id and its occurrence records", () =>
	withFake(async (google, fake) => {
		const id = await google.create("cal-a", lecture(), TO);
		const [item] = await google.listEvents("cal-a", TO);
		assert.equal(await google.move("cal-a", "cal-b", item, lecture(), TO), id);
		assert.equal(fake.calendars.get("cal-a")!.size, 0);
		const [moved] = await google.listEvents("cal-b", TO);
		agrees(moved.event, lecture());
	}));

test("delete removes it, and deleting something already gone is fine", () =>
	withFake(async (google, fake) => {
		const id = await google.create("cal-a", lecture({ recurrence: undefined, exceptions: undefined, overrides: undefined }), TO);
		await google.delete("cal-a", id);
		assert.equal(fake.calendars.get("cal-a")!.size, 0);
		await google.delete("cal-a", "ev-never-existed");
	}));

test("the account name is the primary calendar's address", () =>
	withFake(async (google) => {
		assert.equal(await google.accountName(), "me@example.com");
	}));
