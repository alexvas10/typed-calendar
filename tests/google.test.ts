import assert from "node:assert/strict";
import test from "node:test";
import {
	eventBody, originalStart, readEvents, readExdates, timeFields, type GoogleEvent,
} from "../src/sync/google/mapping";
import { planOverrides, sameMaster, sameMirror, sameRepeat } from "../src/sync/remote";
import type { CalendarEvent } from "../src/model/types";
import { toWallClock, utcOffsetMinutes, wallClockToUtc } from "../src/util/timezone";

const TO = "America/Toronto";

// Shapes as the Calendar API v3 returns them.
const midterm: GoogleEvent = {
	id: "m1d", etag: '"3300"', status: "confirmed", summary: "CS 3600 Midterm",
	location: "MC 4021", updated: "2026-09-20T12:00:00.000Z", iCalUID: "m1d@google.com",
	start: { dateTime: "2026-10-14T14:00:00-04:00", timeZone: TO },
	end: { dateTime: "2026-10-14T16:00:00-04:00", timeZone: TO },
	extendedProperties: { private: { tcUid: "evt-mid", tcTypes: "exam,cs3600", tcProps: '{"weight":45}' } },
};

const lecture: GoogleEvent = {
	id: "lec", etag: '"100"', status: "confirmed", summary: "Lecture", location: "MC 4021",
	updated: "2026-01-02T00:00:00.000Z", iCalUID: "lec@google.com",
	start: { dateTime: "2026-02-04T10:00:00-05:00", timeZone: TO },
	end: { dateTime: "2026-02-04T11:20:00-05:00", timeZone: TO },
	recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20260226T045959Z", "EXDATE;TZID=America/Toronto:20260211T100000"],
};
// Deleted on a phone: a cancelled occurrence record, not an EXDATE.
const cancelled: GoogleEvent = {
	id: "lec_20260225T150000Z", etag: '"101"', status: "cancelled", recurringEventId: "lec",
	originalStartTime: { dateTime: "2026-02-25T10:00:00-05:00", timeZone: TO }, updated: "2026-01-05T00:00:00.000Z",
};
// Moved to Thursday afternoon in another room, for one week.
const moved: GoogleEvent = {
	id: "lec_20260218T150000Z", etag: '"102"', status: "confirmed", recurringEventId: "lec",
	summary: "Lecture", location: "DC 1350", updated: "2026-01-06T00:00:00.000Z",
	originalStartTime: { dateTime: "2026-02-18T10:00:00-05:00", timeZone: TO },
	start: { dateTime: "2026-02-19T14:00:00-05:00", timeZone: TO },
	end: { dateTime: "2026-02-19T15:20:00-05:00", timeZone: TO },
};

test("a one-off event reads with its local time, uid and the plugin's mirror", () => {
	const [item] = readEvents([midterm], TO);
	assert.equal(item.id, "m1d");
	const e = item.event;
	assert.equal(e.uid, "evt-mid", "the plugin's uid wins over Google's iCalUID");
	assert.deepEqual([e.date, e.startTime, e.endTime, e.allDay], ["2026-10-14", "14:00", "16:00", false]);
	assert.equal(e.location, "MC 4021");
	assert.deepEqual(e.types, ["exam", "cs3600"]);
	assert.deepEqual(e.props, { weight: 45 });
	assert.equal(e.remoteModified, "2026-09-20T12:00:00.000Z");
	assert.equal(e.recurring, false);
});

test("an event made on the phone falls back to Google's iCalUID", () => {
	const phone = { ...midterm, extendedProperties: undefined };
	assert.equal(readEvents([phone], TO)[0].event.uid, "m1d@google.com");
});

test("a series reads its rule, both kinds of skipped date, and a moved occurrence", () => {
	const [item] = readEvents([lecture, cancelled, moved], TO);
	const e = item.event;
	assert.deepEqual(e.recurrence, { freq: "weekly", interval: 1, byDay: ["WE"], until: "2026-02-25" });
	assert.deepEqual(e.exceptions, ["2026-02-11", "2026-02-25"], "EXDATE and a cancelled record both skip");
	assert.deepEqual(e.overrides, [
		{ occurrence: "2026-02-18", date: "2026-02-19", startTime: "14:00", endTime: "15:20", location: "DC 1350" },
	]);
	assert.equal(e.remoteModified, "2026-01-06T00:00:00.000Z", "the latest change anywhere in the series");
});

test("a change to one occurrence changes the series' version", () => {
	const before = readEvents([lecture, moved], TO)[0].etag;
	const after = readEvents([lecture, { ...moved, etag: '"103"', location: "HSB 9" }], TO)[0].etag;
	assert.notEqual(before, after, "otherwise a phone-side edit to one week would never be re-read");
	assert.equal(readEvents([lecture, moved], TO)[0].etag, before, "and it is stable when nothing changed");
});

test("special Google events and cancelled events are left alone", () => {
	const ooo = { ...midterm, id: "o", eventType: "outOfOffice" };
	const focus = { ...midterm, id: "f", eventType: "focusTime" };
	const gone = { ...midterm, id: "g", status: "cancelled" };
	assert.deepEqual(readEvents([ooo, focus, gone], TO), []);
});

test("series the plugin cannot author stay the server's", () => {
	const rdate = { ...lecture, recurrence: [...lecture.recurrence!, "RDATE;VALUE=DATE:20260301"] };
	const unreadable = readEvents([rdate], TO)[0].event;
	assert.equal(unreadable.recurring, true);
	assert.equal(unreadable.recurrence, undefined, "RDATE: pull-only");

	// An occurrence record for a Tuesday, which this Wednesday rule never produces.
	const stray = { ...moved, originalStartTime: { dateTime: "2026-02-17T10:00:00-05:00", timeZone: TO } };
	assert.equal(readEvents([lecture, stray], TO)[0].event.recurrence, undefined, "disagreement: pull-only");
});

test("EXDATE values are read in every form Google echoes", () => {
	assert.deepEqual(
		readExdates([
			"EXDATE;VALUE=DATE:20260216,20260217",
			"EXDATE;TZID=America/Toronto:20260218T230000",
			"EXDATE:20260220T030000Z",
		], TO),
		// 03:00Z on the 20th is 22:00 on the 19th in Toronto.
		["2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19"]
	);
});

// --- writing -------------------------------------------------------------------

const note = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
	uid: "evt-lec", title: "Lecture", types: ["class"], date: "2026-02-04", startTime: "10:00",
	endTime: "11:20", allDay: false, location: "MC 4021", timezone: TO, status: "confirmed",
	props: {}, path: "lec.md", ...over,
});

/** What Google sends back for a body we wrote: offsets instead of bare wall time. */
function asStored(id: string, body: Partial<GoogleEvent>, extra: Partial<GoogleEvent> = {}): GoogleEvent {
	const withOffset = (t?: { date?: string; dateTime?: string; timeZone?: string }) => {
		if (!t?.dateTime) return t;
		const [date, time] = t.dateTime.split("T");
		const instant = wallClockToUtc(toWallClock(date, time.slice(0, 5))!, t.timeZone!);
		const minutes = utcOffsetMinutes(instant, t.timeZone!);
		const sign = minutes < 0 ? "-" : "+";
		const abs = Math.abs(minutes);
		const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
		return { dateTime: `${date}T${time}${offset}`, timeZone: t.timeZone };
	};
	return { id, etag: '"1"', status: "confirmed", updated: "2026-01-01T00:00:00.000Z", ...body,
		start: withOffset(body.start), end: withOffset(body.end), ...extra } as GoogleEvent;
}

test("a series is written as wall-clock time with a zone, its rule and skipped dates", () => {
	const body = eventBody(note({
		recurrence: { freq: "weekly", interval: 1, byDay: ["WE"], until: "2026-02-25" },
		exceptions: ["2026-02-11"],
	}), TO);
	assert.deepEqual(body.start, { dateTime: "2026-02-04T10:00:00", timeZone: TO });
	assert.deepEqual(body.end, { dateTime: "2026-02-04T11:20:00", timeZone: TO });
	assert.match(body.recurrence![0], /^RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=/);
	assert.equal(body.recurrence![1], "EXDATE;TZID=America/Toronto:20260211T100000");
	assert.deepEqual(body.extendedProperties?.private, { tcUid: "evt-lec", tcTypes: "class", tcProps: "{}" });
});

test("a written series reads back as the same event", () => {
	const original = note({
		recurrence: { freq: "weekly", interval: 1, byDay: ["WE"], until: "2026-02-25" },
		exceptions: ["2026-02-11"],
	});
	const back = readEvents([asStored("lec", eventBody(original, TO))], TO)[0].event;
	assert.ok(sameMaster(back, original), "fields");
	assert.ok(sameRepeat(back, original, TO), "rule and skips");
	assert.ok(sameMirror(back, { ...original }), "types and fields");
	assert.equal(back.uid, "evt-lec");
});

test("all-day and past-midnight times follow Google's conventions", () => {
	assert.deepEqual(timeFields("2026-02-04", true, undefined, undefined, TO),
		{ start: { date: "2026-02-04" }, end: { date: "2026-02-05" } }, "exclusive end");
	assert.deepEqual(timeFields("2026-02-04", false, "23:00", "01:00", TO).end,
		{ dateTime: "2026-02-05T01:00:00", timeZone: TO }, "ends the next day");
	assert.deepEqual(timeFields("2026-02-04", false, "09:00", undefined, TO).end,
		{ dateTime: "2026-02-04T10:00:00", timeZone: TO }, "an hour when no end is set");
	const allDay = eventBody(note({ allDay: true, startTime: undefined, endTime: undefined,
		recurrence: { freq: "weekly", interval: 1 }, exceptions: ["2026-02-11"] }), TO);
	assert.equal(allDay.recurrence![1], "EXDATE;VALUE=DATE:20260211");
});

test("cleared text is written as empty, so a patch actually clears it", () => {
	const body = eventBody(note({ location: undefined, description: undefined }), TO);
	assert.equal(body.location, "");
	assert.equal(body.description, "");
});

test("an occurrence is found by its original start: an instant, or a date when all-day", () => {
	assert.equal(originalStart(note(), "2026-02-18", TO), "2026-02-18T15:00:00.000Z");
	assert.equal(originalStart(note({ allDay: true, startTime: undefined }), "2026-02-18", TO), "2026-02-18");
});

test("only occurrences that actually differ are rewritten, and dropped ones are reset", () => {
	const series = readEvents([lecture, cancelled, moved], TO)[0].event;
	const same = note({ recurrence: series.recurrence, exceptions: series.exceptions, overrides: series.overrides });
	assert.deepEqual(planOverrides(series, same), { write: [], reset: [] });

	const newRoom = note({ recurrence: series.recurrence, exceptions: series.exceptions,
		overrides: [{ ...series.overrides![0], location: "HSB 9" }] });
	assert.equal(planOverrides(series, newRoom).write.length, 1);

	const reset = note({ recurrence: series.recurrence, exceptions: series.exceptions });
	assert.deepEqual(planOverrides(series, reset), { write: [], reset: ["2026-02-18"] });
});
