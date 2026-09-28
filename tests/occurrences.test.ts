import assert from "node:assert/strict";
import test from "node:test";
import { activeOverrides, applyOverride, buildOverride, expandEvent } from "../src/model/occurrences";
import { applyEventToFrontmatter, eventFromFrontmatter } from "../src/model/serialize";
import { buildPriorityRows } from "../src/model/priority";
import type { CalendarEvent } from "../src/model/types";
import { addDays, startOfToday, toDateString } from "../src/util/dates";

// A Wednesday 10:00 lecture through February 2026.
const lecture = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
	uid: "evt-lec", title: "CS 3600 Lecture", types: ["class"], date: "2026-02-04",
	startTime: "10:00", endTime: "11:20", allDay: false, location: "MC 4021",
	status: "confirmed", props: {}, path: "lec.md",
	recurrence: { freq: "weekly", interval: 1, byDay: ["WE"], until: "2026-02-25" },
	...over,
});
const FEB = { from: "2026-02-01", to: "2026-02-28" };

test("an unchanged series expands to the series' own fields", () => {
	const all = expandEvent(lecture(), FEB);
	assert.deepEqual(all.map((o) => o.date), ["2026-02-04", "2026-02-11", "2026-02-18", "2026-02-25"]);
	assert.ok(all.every((o) => o.startTime === "10:00" && o.location === "MC 4021" && !o.override));
});

test("a moved occurrence appears where it went, and only there", () => {
	const moved = lecture({ overrides: [{ occurrence: "2026-02-18", date: "2026-02-19", startTime: "14:00" }] });
	const all = expandEvent(moved, FEB);
	assert.deepEqual(all.map((o) => o.date), ["2026-02-04", "2026-02-11", "2026-02-19", "2026-02-25"]);
	const thursday = all[2];
	assert.equal(thursday.occurrence, "2026-02-18", "it is still the 18 Feb occurrence");
	assert.equal(thursday.startTime, "14:00");
	assert.equal(thursday.endTime, "11:20", "a field left out follows the series");
});

test("an occurrence moved across the window's edge is placed by its new date", () => {
	const intoMarch = lecture({ overrides: [{ occurrence: "2026-02-25", date: "2026-03-02" }] });
	assert.ok(!expandEvent(intoMarch, FEB).some((o) => o.occurrence === "2026-02-25"));
	assert.deepEqual(
		expandEvent(intoMarch, { from: "2026-03-01", to: "2026-03-31" }).map((o) => o.date),
		["2026-03-02"]
	);
});

test("a skipped occurrence stays skipped even with a change recorded", () => {
	const both = lecture({
		exceptions: ["2026-02-18"],
		overrides: [{ occurrence: "2026-02-18", date: "2026-02-19" }],
	});
	assert.ok(!expandEvent(both, FEB).some((o) => o.occurrence === "2026-02-18"));
	assert.deepEqual(activeOverrides(both), []);
});

test("an override for a date the rule does not produce is inert", () => {
	const stray = lecture({ overrides: [{ occurrence: "2026-02-17", location: "Nowhere" }] });
	assert.equal(expandEvent(stray, FEB).length, 4);
	assert.ok(expandEvent(stray, FEB).every((o) => o.location === "MC 4021"));
	assert.deepEqual(activeOverrides(stray), []);
});

test("an occurrence can become all-day, or timed on an all-day series", () => {
	const allDay = applyOverride(lecture(), "2026-02-11", { occurrence: "2026-02-11", allDay: true });
	assert.equal(allDay.allDay, true);
	assert.equal(allDay.startTime, undefined);

	const holiday = lecture({ allDay: true, startTime: undefined, endTime: undefined });
	const timed = applyOverride(holiday, "2026-02-11", { occurrence: "2026-02-11", startTime: "09:00" });
	assert.equal(timed.allDay, false);
	assert.equal(timed.startTime, "09:00");
});

test("overrides round-trip through frontmatter, sorted and in a stable shape", () => {
	const event = lecture({
		overrides: [
			{ occurrence: "2026-02-18", date: "2026-02-19", location: "DC 1350" },
			{ occurrence: "2026-02-11", title: "Guest lecture" },
		],
	});
	const fm: Record<string, unknown> = {};
	applyEventToFrontmatter(event, fm);
	assert.deepEqual(fm.overrides, [
		{ occurrence: "2026-02-11", title: "Guest lecture" },
		{ occurrence: "2026-02-18", date: "2026-02-19", location: "DC 1350" },
	]);
	const again = eventFromFrontmatter(fm, "lec.md", "lec")!;
	assert.deepEqual(again.overrides, fm.overrides);
});

test("hand-written overrides are read leniently and junk is dropped", () => {
	const event = eventFromFrontmatter(
		{
			uid: "evt-lec",
			date: "2026-02-04",
			recurrence: { freq: "weekly" },
			overrides: [
				{ occurrence: new Date(2026, 1, 18), startTime: "9:05", allDay: false },
				{ date: "2026-02-20" },
				"not an override",
				{ occurrence: "2026-02-11", location: "  " },
			],
		},
		"lec.md",
		"lec"
	)!;
	assert.deepEqual(event.overrides, [
		{ occurrence: "2026-02-11" },
		{ occurrence: "2026-02-18", allDay: false, startTime: "09:05" },
	]);
});

test("overrides are not written for an event that no longer repeats", () => {
	const fm: Record<string, unknown> = { overrides: [{ occurrence: "2026-02-18" }] };
	applyEventToFrontmatter(
		lecture({ recurrence: undefined, overrides: [{ occurrence: "2026-02-18" }] }),
		fm
	);
	assert.equal(fm.overrides, undefined);
});

test("the priority list shows a changed occurrence as it now is", () => {
	const today = toDateString(startOfToday());
	const series = lecture({
		date: today,
		recurrence: { freq: "daily", interval: 1, count: 3 },
		overrides: [{ occurrence: addDays(today, 1), title: "Review session", location: "DC 1350" }],
	});
	const rows = buildPriorityRows([series], [], 7);
	assert.equal(rows.length, 3);
	const changed = rows.find((row) => row.occurrence === addDays(today, 1))!;
	assert.equal(changed.title, "Review session");
	assert.ok(changed.annotations.includes("DC 1350"));
	assert.ok(!changed.annotations.includes("MC 4021"));
});

test("only a literal readOnly: true locks, and it round-trips", () => {
	const locked = eventFromFrontmatter({ uid: "a", date: "2025-01-06", readOnly: true }, "a.md", "a")!;
	assert.equal(locked.readOnly, true);
	for (const value of ["true", "yes", 1, false]) {
		const loose = eventFromFrontmatter({ uid: "a", date: "2025-01-06", readOnly: value }, "a.md", "a")!;
		assert.equal(loose.readOnly, undefined, `readOnly: ${JSON.stringify(value)} should not lock`);
	}
	const fm: Record<string, unknown> = { readOnly: true };
	applyEventToFrontmatter(locked, fm);
	assert.equal(fm.readOnly, true);
	applyEventToFrontmatter({ ...locked, readOnly: undefined }, fm);
	assert.equal("readOnly" in fm, false);
});

// --- building an override from a drag or the occurrence editor ------------------

const timed = (date: string, startTime: string, endTime?: string) =>
	({ date, allDay: false, startTime, endTime });

test("dragging one lecture to Thursday records only the move", () => {
	const override = buildOverride(lecture(), "2026-02-18", timed("2026-02-19", "10:00", "11:20"));
	assert.deepEqual(override, { occurrence: "2026-02-18", date: "2026-02-19" });
});

test("dragging to a new time on the same day records only the time", () => {
	const override = buildOverride(lecture(), "2026-02-18", timed("2026-02-18", "13:00", "14:20"));
	assert.deepEqual(override, { occurrence: "2026-02-18", startTime: "13:00", endTime: "14:20" });
});

test("dropping it where it already was changes nothing", () => {
	assert.equal(buildOverride(lecture(), "2026-02-18", timed("2026-02-18", "10:00", "11:20")), null);
});

test("a drag keeps the room and title an occurrence already had", () => {
	const existing = { occurrence: "2026-02-18", location: "DC 1350", title: "Review", description: "Bring notes" };
	const override = buildOverride(lecture(), "2026-02-18", timed("2026-02-20", "10:00", "11:20"), existing);
	assert.deepEqual(override, {
		occurrence: "2026-02-18", date: "2026-02-20", title: "Review", location: "DC 1350",
		description: "Bring notes",
	});
});

test("dragging a changed occurrence back keeps its entry rather than deleting it", () => {
	// A bare entry is how a server-side change the plugin does not model (an
	// alarm on that one occurrence) survives; only Reset removes it.
	const existing = { occurrence: "2026-02-18", date: "2026-02-19" };
	assert.deepEqual(
		buildOverride(lecture(), "2026-02-18", timed("2026-02-18", "10:00", "11:20"), existing),
		{ occurrence: "2026-02-18" }
	);
});

test("dragging into the all-day row makes just that occurrence all-day", () => {
	const override = buildOverride(lecture(), "2026-02-18", { date: "2026-02-18", allDay: true });
	assert.deepEqual(override, { occurrence: "2026-02-18", allDay: true });
});

test("the editor's blank title and room mean 'same as the series'", () => {
	const existing = { occurrence: "2026-02-18", location: "DC 1350" };
	const override = buildOverride(
		lecture(), "2026-02-18", { ...timed("2026-02-18", "10:00", "11:20"), title: "", location: "" }, existing
	);
	assert.deepEqual(override, { occurrence: "2026-02-18" });
});
