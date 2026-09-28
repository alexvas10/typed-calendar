import assert from "node:assert/strict";
import test from "node:test";
import {
	EXPAND_PROPERTIES, PROPERTY, eventBody, fromPattern, occurrenceWindow, outlookRuleProblem,
	readEvent, timeFields, toPattern, type GraphEvent,
} from "../src/sync/outlook/mapping";
import { parseRecurrence, type RecurrenceRule } from "../src/model/recurrence";
import type { CalendarEvent } from "../src/model/types";

const TO = "America/Toronto";
const rule = (value: Record<string, unknown>) => parseRecurrence(value) as RecurrenceRule;

test("every rule Outlook can hold survives the trip to a pattern and back", () => {
	const cases: [string, RecurrenceRule][] = [
		["2026-01-05", rule({ freq: "daily", interval: 2, count: 10 })],
		["2026-01-05", rule({ freq: "weekly", byDay: ["MO", "WE", "FR"], until: "2026-04-08" })],
		["2026-01-05", rule({ freq: "weekly", interval: 2, byDay: ["MO"] })],
		["2026-01-05", rule({ freq: "monthly" })],
		["2026-01-05", rule({ freq: "monthly", byMonthDay: [15] })],
		["2026-01-13", rule({ freq: "monthly", byDay: ["2TU"] })],
		["2026-01-30", rule({ freq: "monthly", byDay: ["-1FR"] })],
		["2026-01-30", rule({ freq: "monthly", byDay: ["MO", "TU", "WE", "TH", "FR"], bySetPos: [-1] })],
		["2026-11-26", rule({ freq: "yearly", byMonth: [11], byDay: ["4TH"] })],
		["2026-03-14", rule({ freq: "yearly" })],
	];
	for (const [start, original] of cases) {
		assert.equal(outlookRuleProblem(original), null, JSON.stringify(original));
		const { pattern, range } = toPattern(original, start, TO);
		assert.deepEqual(fromPattern(pattern, range, start), original, `${start} ${JSON.stringify(original)}`);
	}
});

test("rules with no Outlook pattern are refused with a reason, not flattened", () => {
	for (const unsupported of [
		rule({ freq: "monthly", byMonthDay: [1, 15] }),
		rule({ freq: "monthly", byMonthDay: [-1] }),
		rule({ freq: "monthly", byDay: ["5FR"] }),
		rule({ freq: "monthly", byDay: ["2TU", "4TU"] }),
		rule({ freq: "yearly", byMonth: [3, 9] }),
		rule({ freq: "monthly", byDay: ["FR"], byMonthDay: [13] }),
	]) {
		assert.ok(outlookRuleProblem(unsupported), `should refuse ${JSON.stringify(unsupported)}`);
	}
});

test("a weekly pattern is anchored on Sunday, as expansion is", () => {
	const { pattern } = toPattern(rule({ freq: "weekly", interval: 2, byDay: ["MO"] }), "2026-01-05", TO);
	assert.equal(pattern.firstDayOfWeek, "sunday");
	assert.equal(fromPattern({ ...pattern, firstDayOfWeek: "monday" }, { type: "noEnd", startDate: "2026-01-05" }, "2026-01-05"),
		null, "every-other-week anchored elsewhere would skip different weeks");
});

// --- reading a series with one moved week and one deleted week ------------------

const master: GraphEvent = {
	id: "AAMk-master", changeKey: "ck1", type: "seriesMaster", subject: "Lecture",
	location: { displayName: "MC 4021" }, body: { contentType: "text", content: "" },
	start: { dateTime: "2026-02-04T10:00:00.0000000", timeZone: TO },
	end: { dateTime: "2026-02-04T11:20:00.0000000", timeZone: TO },
	isAllDay: false, lastModifiedDateTime: "2026-01-06T00:00:00Z", iCalUId: "040000008200E0",
	recurrence: {
		pattern: { type: "weekly", interval: 1, daysOfWeek: ["wednesday"], firstDayOfWeek: "sunday" },
		range: { type: "endDate", startDate: "2026-02-04", endDate: "2026-02-25", recurrenceTimeZone: TO },
	},
	singleValueExtendedProperties: [
		{ id: PROPERTY.uid, value: "evt-lec" }, { id: PROPERTY.types, value: "class" }, { id: PROPERTY.props, value: "{}" },
	],
};
const occurrence = (date: string): GraphEvent => ({
	id: `occ-${date}`, type: "occurrence", subject: "Lecture", originalStart: `${date}T15:00:00Z`,
	start: { dateTime: `${date}T10:00:00.0000000`, timeZone: TO }, end: { dateTime: `${date}T11:20:00.0000000`, timeZone: TO },
	location: { displayName: "MC 4021" },
});
const movedWeek: GraphEvent = {
	id: "exc-0218", changeKey: "ck9", type: "exception", subject: "Lecture", originalStart: "2026-02-18T15:00:00Z",
	start: { dateTime: "2026-02-19T14:00:00.0000000", timeZone: TO }, end: { dateTime: "2026-02-19T15:20:00.0000000", timeZone: TO },
	location: { displayName: "DC 1350" },
};
// 11 Feb is missing: deleted in Outlook.
const instances = [occurrence("2026-02-04"), movedWeek, occurrence("2026-02-25")];
const window = { from: "2026-02-04", to: "2026-02-25" };

test("a series reads its rule, the deleted week, and the moved week", () => {
	const item = readEvent(master, instances, window)!;
	const e = item.event;
	assert.equal(e.uid, "evt-lec");
	assert.deepEqual([e.date, e.startTime, e.endTime], ["2026-02-04", "10:00", "11:20"]);
	assert.deepEqual(e.recurrence, { freq: "weekly", interval: 1, byDay: ["WE"], until: "2026-02-25" });
	assert.deepEqual(e.exceptions, ["2026-02-11"], "missing from the occurrence list: deleted");
	assert.deepEqual(e.overrides, [
		{ occurrence: "2026-02-18", date: "2026-02-19", startTime: "14:00", endTime: "15:20", location: "DC 1350" },
	]);
	assert.deepEqual(e.types, ["class"]);
});

test("the series' version changes when one week changes", () => {
	const before = readEvent(master, instances, window)!.etag;
	const edited = [occurrence("2026-02-04"), { ...movedWeek, changeKey: "ck10" }, occurrence("2026-02-25")];
	assert.notEqual(readEvent(master, edited, window)!.etag, before);
	const deleted = [occurrence("2026-02-04"), movedWeek];
	assert.notEqual(readEvent(master, deleted, window)!.etag, before, "deleting a week is a change too");
});

test("a pattern the plugin cannot represent leaves the series Outlook's", () => {
	const odd = { ...master, recurrence: { ...master.recurrence!, pattern: { ...master.recurrence!.pattern, type: "hourly" } } } as unknown as GraphEvent;
	const e = readEvent(odd, instances, window)!.event;
	assert.equal(e.recurring, true);
	assert.equal(e.recurrence, undefined);
});

test("a one-off reads as wall-clock time in the requested zone, all-day as a date", () => {
	const one: GraphEvent = { ...master, id: "one", type: "singleInstance", recurrence: null };
	const e = readEvent(one, [], window)!.event;
	assert.deepEqual([e.date, e.startTime, e.recurring], ["2026-02-04", "10:00", false]);
	const allDay = readEvent({ ...one, isAllDay: true, start: { dateTime: "2026-02-04T00:00:00.0000000", timeZone: TO } }, [], window)!.event;
	assert.deepEqual([allDay.date, allDay.allDay, allDay.startTime], ["2026-02-04", true, undefined]);
	assert.equal(readEvent({ ...one, singleValueExtendedProperties: undefined }, [], window)!.event.uid, "040000008200E0",
		"an event made in Outlook falls back to its iCalUId");
});

// --- writing -------------------------------------------------------------------

const note = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
	uid: "evt-lec", title: "Lecture", types: ["class"], date: "2026-02-04", startTime: "10:00", endTime: "11:20",
	allDay: false, location: "MC 4021", timezone: TO, status: "confirmed", props: {}, path: "lec.md", ...over,
});

test("a written event carries wall-clock times, its pattern and the private properties", () => {
	const body = eventBody(note({ recurrence: rule({ freq: "weekly", byDay: ["WE"], until: "2026-02-25" }) }), TO);
	assert.deepEqual(body.start, { dateTime: "2026-02-04T10:00:00", timeZone: TO });
	assert.equal(body.isAllDay, false);
	assert.deepEqual((body.recurrence as { range: unknown }).range,
		{ type: "endDate", startDate: "2026-02-04", endDate: "2026-02-25", recurrenceTimeZone: TO });
	assert.deepEqual(body.location, { displayName: "MC 4021" });
	assert.equal((body.singleValueExtendedProperties as { id: string; value: string }[])
		.find((p) => p.id === PROPERTY.types)?.value, "class");
});

test("an all-day event runs midnight to midnight, and a late one past midnight", () => {
	assert.deepEqual(timeFields("2026-02-04", true, undefined, undefined, TO).end,
		{ dateTime: "2026-02-05T00:00:00", timeZone: TO });
	assert.deepEqual(timeFields("2026-02-04", false, "23:00", "01:00", TO).end,
		{ dateTime: "2026-02-05T01:00:00", timeZone: TO });
});

test("occurrences are listed over the series' own span, capped for endless ones", () => {
	assert.deepEqual(occurrenceWindow("2026-02-04", rule({ freq: "weekly", until: "2026-02-25" }), "2026-09-27"),
		{ from: "2026-02-04", to: "2026-02-25" });
	assert.deepEqual(occurrenceWindow("2026-02-04", rule({ freq: "weekly", count: 3 }), "2026-09-27"),
		{ from: "2026-02-04", to: "2026-02-18" });
	assert.equal(occurrenceWindow("2026-02-04", rule({ freq: "weekly" }), "2026-09-27").to, "2028-09-26");
});

test("the expand clause asks for exactly the plugin's three properties", () => {
	assert.equal((EXPAND_PROPERTIES.match(/id eq '/g) ?? []).length, 3);
	assert.match(EXPAND_PROPERTIES, /^singleValueExtendedProperties\(\$filter=/);
});
