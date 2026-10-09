import assert from "node:assert/strict";
import test from "node:test";
import ICAL from "ical.js";
import { icsToEvent, patchICS } from "../src/sync/ics";
import { expandEvent, withOccurrenceDone, buildOverride } from "../src/model/occurrences";
import { parseOverrides, overridesToFrontmatter } from "../src/model/serialize";
import { buildPriorityRows } from "../src/model/priority";
import { occurrenceBody as googleOccurrence, readEvent as readGoogleEvent, type GoogleEvent } from "../src/sync/google/mapping";
import { planOverrides } from "../src/sync/remote";
import type { CalendarEvent } from "../src/model/types";

const TO = "America/Toronto";

// A weekly Apple series with an alarm, four Wednesdays from 11 Feb.
const WEEKLY_ICS = [
	"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple Inc.//iOS 18//EN",
	"BEGIN:VEVENT", "UID:apple-1", "SUMMARY:Quiz",
	"DTSTART;TZID=America/Toronto:20260211T180000", "DTEND;TZID=America/Toronto:20260211T200000",
	"LOCATION:MC 4021", "SEQUENCE:2", "RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4",
	"LAST-MODIFIED:20260107T160506Z", "DTSTAMP:20260107T160506Z",
	"BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT30M", "DESCRIPTION:Reminder", "END:VALARM",
	"END:VEVENT", "END:VCALENDAR",
].join("\r\n");

const weekly = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
	uid: "apple-1", title: "Quiz", types: [], date: "2026-02-11",
	startTime: "18:00", endTime: "20:00", allDay: false, location: "MC 4021",
	timezone: TO, status: "confirmed", props: {}, path: "a.md",
	recurrence: { freq: "weekly", interval: 1, byDay: ["WE"], count: 4 }, ...over,
});

const summaries = (ics: string) =>
	new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents("vevent").map((c) => c.getFirstPropertyValue("summary"));

test("crossing off one week adds a bare entry; un-crossing keeps the entry", () => {
	const once = withOccurrenceDone(undefined, "2026-02-18", true);
	assert.deepEqual(once, [{ occurrence: "2026-02-18", done: true }]);
	const moved = withOccurrenceDone([{ occurrence: "2026-02-18", location: "DC 1350" }], "2026-02-18", true);
	assert.deepEqual(moved, [{ occurrence: "2026-02-18", location: "DC 1350", done: true }]);
	assert.deepEqual(withOccurrenceDone(once, "2026-02-18", false), [{ occurrence: "2026-02-18" }]);
	assert.deepEqual(parseOverrides(overridesToFrontmatter(once)), once, "round-trips through a note");
	const change = { date: "2026-02-19", allDay: false, startTime: "18:00", endTime: "20:00" };
	assert.equal(buildOverride(weekly(), "2026-02-18", change, once[0])!.done, true, "moving a crossed-off week keeps it crossed off");
});

test("a crossed-off week is done alone; a done series is done every week", () => {
	const weeks = expandEvent(weekly({ overrides: [{ occurrence: "2026-02-18", done: true }] }), { from: "2026-02-01", to: "2026-03-31" });
	assert.deepEqual(weeks.map((w) => [w.date, Boolean(w.done)]), [
		["2026-02-11", false], ["2026-02-18", true], ["2026-02-25", false], ["2026-03-04", false],
	]);
	assert.ok(expandEvent(weekly({ done: true }), { from: "2026-02-01", to: "2026-03-31" }).every((w) => w.done));
});

test("iCloud: a crossed-off week is a marked RECURRENCE-ID, read back as that week done", () => {
	assert.equal(patchICS(WEEKLY_ICS, weekly(), TO)!.changed, false, "nothing crossed off: still a no-op");

	const event = weekly({ overrides: [{ occurrence: "2026-02-18", done: true }] });
	const r = patchICS(WEEKLY_ICS, event, TO)!;
	assert.equal(r.changed, true);
	assert.deepEqual(summaries(r.ics), ["Quiz", "✓ Quiz"]);
	assert.equal((r.ics.match(/TRIGGER:-PT30M/g) ?? []).length, 2, "the series' alarm is copied onto the new component");

	const parsed = icsToEvent(r.ics, TO)!;
	assert.equal(parsed.done, undefined, "the series itself is not done");
	assert.deepEqual(parsed.overrides, [{ occurrence: "2026-02-18", done: true }]);
	assert.equal(patchICS(r.ics, event, TO)!.changed, false, "the next sync is a no-op");

	const undone = patchICS(r.ics, weekly({ overrides: [{ occurrence: "2026-02-18" }] }), TO)!;
	assert.equal(undone.changed, true);
	assert.deepEqual(summaries(undone.ics), ["Quiz", "Quiz"], "un-crossing writes the plain title and keeps the component");
});

test("a done series is not read as every week crossed off separately", () => {
	const event = weekly({ done: true, overrides: [{ occurrence: "2026-02-18", location: "DC 1350" }] });
	const r = patchICS(WEEKLY_ICS, event, TO)!;
	assert.deepEqual(summaries(r.ics), ["✓ Quiz", "✓ Quiz"]);
	const parsed = icsToEvent(r.ics, TO)!;
	assert.equal(parsed.done, true);
	assert.deepEqual(parsed.overrides, [{ occurrence: "2026-02-18", location: "DC 1350" }]);
});

test("the priority list leaves crossed-off weeks out when asked", () => {
	const today = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const start = iso(today);
	const next = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7));
	const event = weekly({ date: start, recurrence: { freq: "weekly", interval: 1, count: 2 }, overrides: [{ occurrence: start, done: true }] });
	assert.deepEqual(buildPriorityRows([event], [], 30, true).map((r) => r.date), [next]);
	assert.equal(buildPriorityRows([event], [], 30, false).length, 2);
});

test("Google: one crossed-off week is written, read, and compared", () => {
	const event = weekly({ overrides: [{ occurrence: "2026-02-18", done: true }] });
	assert.equal(googleOccurrence(event, "2026-02-18", event.overrides![0], TO).summary, "✓ Quiz");
	assert.equal(googleOccurrence(event, "2026-02-25", undefined, TO).summary, "Quiz");

	const master: GoogleEvent = {
		id: "q", etag: '"1"', status: "confirmed", summary: "Quiz", updated: "2026-01-02T00:00:00.000Z",
		start: { dateTime: "2026-02-11T18:00:00-05:00", timeZone: TO }, end: { dateTime: "2026-02-11T20:00:00-05:00", timeZone: TO },
		location: "MC 4021", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4"],
	};
	const instance: GoogleEvent = {
		id: "q_20260218", etag: '"2"', status: "confirmed", recurringEventId: "q", summary: "✓ Quiz", location: "MC 4021",
		originalStartTime: { dateTime: "2026-02-18T18:00:00-05:00", timeZone: TO },
		start: { dateTime: "2026-02-18T18:00:00-05:00", timeZone: TO }, end: { dateTime: "2026-02-18T20:00:00-05:00", timeZone: TO },
	};
	const parsed = readGoogleEvent(master, [instance], TO)!;
	assert.deepEqual(parsed.overrides, [{ occurrence: "2026-02-18", done: true }]);
	assert.deepEqual(planOverrides(parsed, event).write, [], "already crossed off there: nothing to write");
	assert.deepEqual(planOverrides(readGoogleEvent(master, [], TO)!, event).write.map((o) => o.occurrence), ["2026-02-18"]);
});
