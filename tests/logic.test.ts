import assert from "node:assert/strict";
import test from "node:test";
import { eventFromFrontmatter, applyEventToFrontmatter } from "../src/model/serialize";
import { buildPriorityRows, missingFields, indexTypes } from "../src/model/priority";
import { DEFAULT_EVENT_TYPES } from "../src/model/defaults";
import { isScheduled, type CalendarEvent } from "../src/model/types";
import { daysUntil, startOfToday, formatRelativeDays } from "../src/util/dates";
import { uniqueTypeId } from "../src/settings/settings";

const inDays = (n: number) => {
	const d = startOfToday();
	d.setDate(d.getDate() + n);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

test("parses a typed event out of frontmatter", () => {
	const ev = eventFromFrontmatter(
		{ uid: "evt-1", title: "Midterm", types: ["exam", "cs3600"], date: "2026-10-14",
		  startTime: "14:00", endTime: "16:00", location: "MC 4021", props: { weight: 45 } },
		"Calendar/Events/x.md", "x");
	assert.ok(ev);
	assert.deepEqual(ev.types, ["exam", "cs3600"]);
	assert.equal(ev.allDay, false);
	assert.equal(ev.props.weight, 45);
	assert.equal(isScheduled(ev), true);
});

test("a Date object from the YAML parser does not shift the day", () => {
	const ev = eventFromFrontmatter({ types: ["exam"], date: new Date(2026, 9, 14) }, "p.md", "p");
	assert.equal(ev?.date, "2026-10-14");
});

test("an event with no date is unscheduled, not dropped", () => {
	const ev = eventFromFrontmatter({ types: ["exam"], title: "Final - TBD" }, "p.md", "p");
	assert.ok(ev);
	assert.equal(ev.date, undefined);
	assert.equal(isScheduled(ev), false);
});

test("status tbd keeps a dated event off the calendar", () => {
	const ev = eventFromFrontmatter({ types: ["exam"], date: "2026-12-01", status: "tbd" }, "p.md", "p");
	assert.equal(isScheduled(ev!), false);
});

test("a note with no managed keys is not an event", () => {
	assert.equal(eventFromFrontmatter({ tags: ["note"] }, "p.md", "p"), null);
	assert.equal(eventFromFrontmatter(undefined, "p.md", "p"), null);
});

test("missing start time forces all-day", () => {
	const ev = eventFromFrontmatter({ types: ["class"], date: "2026-10-14", allDay: false }, "p.md", "p");
	assert.equal(ev?.allDay, true);
});

test("round-trips through frontmatter without losing custom props", () => {
	const ev = eventFromFrontmatter(
		{ uid: "u", title: "T", types: ["exam"], date: "2026-10-14", props: { weight: 45 } }, "p.md", "p")!;
	const fm: Record<string, unknown> = { unrelated: "keep me" };
	applyEventToFrontmatter(ev, fm);
	assert.equal(fm.unrelated, "keep me");
	const again = eventFromFrontmatter(fm, "p.md", "p")!;
	assert.deepEqual(again.props, { weight: 45 });
	assert.deepEqual(again.types, ["exam"]);
});

test("clearing a field removes the key rather than leaving it empty", () => {
	const fm: Record<string, unknown> = { location: "old" };
	applyEventToFrontmatter({ uid: "u", title: "T", types: [], allDay: true, status: "confirmed",
		props: {}, path: "p.md" } as CalendarEvent, fm);
	assert.equal("location" in fm, false);
});

test("priority orders the birthday in 2 days above the 45% exam in 3", () => {
	const types = [...DEFAULT_EVENT_TYPES];
	const events = [
		{ uid: "a", title: "CS 3600 Midterm", types: ["exam"], date: inDays(3), allDay: true,
		  status: "confirmed", props: { weight: 45 }, path: "a.md" },
		{ uid: "b", title: "Paul's birthday", types: ["personal"], date: inDays(2), allDay: true,
		  status: "confirmed", props: {}, path: "b.md" },
	] as CalendarEvent[];
	const rows = buildPriorityRows(events, types, 30);
	assert.deepEqual(rows.map((r) => r.event.title), ["Paul's birthday", "CS 3600 Midterm"]);
	assert.equal(formatRelativeDays(rows[0].days), "in 2 days");
	assert.ok(rows[1].annotations.includes("45%"));
});

test("same day ties break by type rank then weight", () => {
	const day = inDays(5);
	const mk = (t: string, types: string[], w?: number) => ({ uid: t, title: t, types, date: day,
		allDay: true, status: "confirmed", props: w ? { weight: w } : {}, path: `${t}.md` }) as CalendarEvent;
	const rows = buildPriorityRows(
		[mk("lecture", ["class"]), mk("quiz", ["exam"], 5), mk("final", ["exam"], 45), mk("essay", ["assignment"], 30)],
		DEFAULT_EVENT_TYPES, 30);
	assert.deepEqual(rows.map((r) => r.event.title), ["final", "quiz", "essay", "lecture"]);
});

test("past events and events beyond the horizon are excluded", () => {
	const mk = (t: string, d: string) => ({ uid: t, title: t, types: ["exam"], date: d, allDay: true,
		status: "confirmed", props: {}, path: `${t}.md` }) as CalendarEvent;
	const rows = buildPriorityRows([mk("past", inDays(-1)), mk("far", inDays(40)), mk("soon", inDays(1))],
		DEFAULT_EVENT_TYPES, 30);
	assert.deepEqual(rows.map((r) => r.event.title), ["soon"]);
});

test("missingFields reports an absent date", () => {
	const typeMap = indexTypes(DEFAULT_EVENT_TYPES);
	const ev = { uid: "u", title: "Final", types: ["exam"], allDay: true, status: "tbd",
		props: {}, path: "p.md" } as CalendarEvent;
	assert.deepEqual(missingFields(ev, typeMap), ["date"]);
});

test("daysUntil is not thrown off by timezone", () => {
	assert.equal(daysUntil(inDays(0)), 0);
	assert.equal(daysUntil(inDays(7)), 7);
});

// --- repeating events -------------------------------------------------------

test("a recurrence block survives a frontmatter round trip", () => {
	const fm: Record<string, unknown> = {
		uid: "evt-class", title: "BUS 1220 Lecture", types: ["class"], date: "2026-01-05",
		startTime: "10:00", endTime: "11:20",
		recurrence: { freq: "weekly", interval: 1, byDay: ["MO", "WE", "FR"], until: "2026-04-08" },
		exceptions: ["2026-02-18", "2026-02-16"],
	};
	const parsed = eventFromFrontmatter(fm, "a.md", "a")!;
	assert.deepEqual(parsed.recurrence, {
		freq: "weekly", interval: 1, byDay: ["MO", "WE", "FR"], until: "2026-04-08",
	});
	assert.deepEqual(parsed.exceptions, ["2026-02-16", "2026-02-18"]);

	const written: Record<string, unknown> = {};
	applyEventToFrontmatter(parsed, written);
	assert.deepEqual(written.recurrence, fm.recurrence);
	assert.deepEqual(written.exceptions, ["2026-02-16", "2026-02-18"]);
});

test("exceptions do not outlive the rule they belong to", () => {
	const event = eventFromFrontmatter(
		{ uid: "e", title: "T", date: "2026-01-05", exceptions: ["2026-02-16"] }, "a.md", "a")!;
	const written: Record<string, unknown> = {};
	applyEventToFrontmatter(event, written);
	// Left behind, they would hide an occurrence of an event that no longer
	// has any occurrences to hide.
	assert.equal("exceptions" in written, false);
});

test("a class shows in priority on each of its days, minus the holidays", () => {
	const monday = new Date(startOfToday());
	monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
	const start = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
	const second = inDays(daysUntil(start)! + 7);

	const event: CalendarEvent = {
		uid: "e", title: "Lecture", types: ["class"], date: start, allDay: true,
		status: "confirmed", props: {}, path: "a.md",
		recurrence: { freq: "weekly", interval: 1, byDay: ["MO"] },
	};
	const rows = buildPriorityRows([event], DEFAULT_EVENT_TYPES, 21);
	assert.ok(rows.length >= 3, `expected several occurrences, got ${rows.length}`);
	assert.equal(rows[0].date, start);

	const skipped = buildPriorityRows(
		[{ ...event, exceptions: [second] }], DEFAULT_EVENT_TYPES, 21);
	assert.equal(skipped.length, rows.length - 1);
	assert.ok(!skipped.some((row) => row.date === second));
});

test("a new type gets a readable id derived from its name", () => {
	const types = [{ id: "exam", label: "Exam", color: "#a00", rank: 30, fields: [] }];
	assert.equal(uniqueTypeId("Lecture", types), "lecture");
	assert.equal(uniqueTypeId("CS 3600 Lab", types), "cs-3600-lab");
	// Punctuation and edge whitespace never reach the id.
	assert.equal(uniqueTypeId("  Office hours!  ", types), "office-hours");
});

test("a type id never collides with one already in use", () => {
	const types = [
		{ id: "lecture", label: "Lecture", color: "#a00", rank: 10, fields: [] },
		{ id: "lecture-2", label: "Lecture", color: "#0a0", rank: 10, fields: [] },
	];
	assert.equal(uniqueTypeId("Lecture", types), "lecture-3");
});

test("a name with nothing id-able still yields a usable id", () => {
	// Ids are referenced by every event carrying the type, so "" is not an
	// option even when the label is punctuation only.
	const id = uniqueTypeId("!!!", []);
	assert.match(id, /^type-[a-z0-9]+$/);
});
