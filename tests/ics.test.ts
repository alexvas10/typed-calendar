import assert from "node:assert/strict";
import test from "node:test";
import { eventToICS, icsToEvent } from "../src/sync/ics";
import type { CalendarEvent } from "../src/model/types";

const TO = "America/Toronto";

const base = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
	uid: "evt-1", title: "CS 3600 Midterm", types: ["exam", "cs3600"],
	date: "2026-10-14", startTime: "14:00", endTime: "16:00", allDay: false,
	location: "MC 4021", timezone: TO, status: "confirmed",
	props: { weight: 45, course: "CS 3600" }, path: "a.md", ...over,
});

test("a timed event round-trips through iCalendar unchanged", () => {
	const parsed = icsToEvent(eventToICS(base(), TO), TO)!;
	assert.equal(parsed.uid, "evt-1");
	assert.equal(parsed.title, "CS 3600 Midterm");
	assert.equal(parsed.date, "2026-10-14");
	assert.equal(parsed.startTime, "14:00");
	assert.equal(parsed.endTime, "16:00");
	assert.equal(parsed.allDay, false);
	assert.equal(parsed.location, "MC 4021");
});

test("timed events are written as UTC instants", () => {
	// 14:00 in Toronto in October is EDT (-4), so 18:00Z.
	assert.match(eventToICS(base(), TO), /DTSTART:20261014T180000Z/);
});

test("an all-day event uses DATE values with an exclusive end", () => {
	const ics = eventToICS(base({ allDay: true, startTime: undefined, endTime: undefined }), TO);
	assert.match(ics, /DTSTART;VALUE=DATE:20261014/);
	assert.match(ics, /DTEND;VALUE=DATE:20261015/);
	const parsed = icsToEvent(ics, TO)!;
	assert.equal(parsed.allDay, true);
	assert.equal(parsed.date, "2026-10-14");
});

test("types and custom props are mirrored into X- properties", () => {
	const parsed = icsToEvent(eventToICS(base(), TO), TO)!;
	assert.deepEqual(parsed.types, ["exam", "cs3600"]);
	assert.deepEqual(parsed.props, { weight: 45, course: "CS 3600" });
});

test("a missing end time defaults to one hour", () => {
	const parsed = icsToEvent(eventToICS(base({ endTime: undefined }), TO), TO)!;
	assert.equal(parsed.endTime, "15:00");
});

test("an end before the start runs past midnight rather than backwards", () => {
	const ics = eventToICS(base({ startTime: "23:00", endTime: "01:00" }), TO);
	assert.match(ics, /DTEND:20261015T050000Z/);
});

test("special characters survive RFC 5545 escaping", () => {
	const tricky = base({ title: "Essay: draft, part 1; \"final\"", location: "Room A, B\\C" });
	const parsed = icsToEvent(eventToICS(tricky, TO), TO)!;
	assert.equal(parsed.title, tricky.title);
	assert.equal(parsed.location, tricky.location);
});

test("a long title is folded and unfolds cleanly", () => {
	const long = "Assignment ".repeat(30).trim();
	const ics = eventToICS(base({ title: long }), TO);
	// 75 content octets, plus the leading space on each continuation line.
	assert.ok(ics.split("\r\n").every((line) => line.length <= 76), "lines should be folded");
	assert.ok(ics.split("\r\n").some((line) => line.startsWith(" ")), "expected a continuation line");
	assert.equal(icsToEvent(ics, TO)!.title, long);
});

test("refuses to serialise an undated event", () => {
	assert.throws(() => eventToICS(base({ date: undefined }), TO), /no date/i);
});

test("garbage input is reported as unparseable, not thrown", () => {
	assert.equal(icsToEvent("not an ics file", TO), null);
	assert.equal(icsToEvent("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", TO), null);
});

test("an event from another client with no X- props still parses", () => {
	const foreign = [
		"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple//EN", "BEGIN:VEVENT",
		"UID:apple-123", "SUMMARY:Dentist", "DTSTART:20261014T140000Z",
		"DTEND:20261014T150000Z", "LAST-MODIFIED:20260920T120000Z", "END:VEVENT", "END:VCALENDAR",
	].join("\r\n");
	const parsed = icsToEvent(foreign, TO)!;
	assert.equal(parsed.uid, "apple-123");
	assert.equal(parsed.startTime, "10:00"); // 14:00Z is 10:00 EDT
	assert.equal(parsed.types, undefined);
	assert.equal(parsed.remoteModified, "2026-09-20T12:00:00.000Z");
});

test("a recurring series is flagged and resolves to its master VEVENT", () => {
	const series = [
		"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple//EN",
		"BEGIN:VEVENT", "UID:cls-1", "SUMMARY:Lecture", "DTSTART:20260908T130000Z",
		"DTEND:20260908T142000Z", "RRULE:FREQ=WEEKLY;BYDAY=TU", "END:VEVENT",
		"BEGIN:VEVENT", "UID:cls-1", "RECURRENCE-ID:20260915T130000Z", "SUMMARY:Lecture (moved)",
		"DTSTART:20260915T150000Z", "DTEND:20260915T162000Z", "END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
	const parsed = icsToEvent(series, TO)!;
	assert.equal(parsed.recurring, true);
	assert.equal(parsed.title, "Lecture");
});
