import assert from "node:assert/strict";
import test from "node:test";
import ICAL from "ical.js";
import { patchICS, icsToEvent, eventToICS } from "../src/sync/ics";
import type { CalendarEvent } from "../src/model/types";

const TO = "America/Toronto";

// A realistic Apple event: TZID times, an alarm, attendee, URL, X-APPLE props.
const APPLE = [
	"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple Inc.//iOS 18//EN",
	"BEGIN:VEVENT", "UID:apple-1", "SUMMARY:2214 Test 1",
	"DTSTART;TZID=America/Toronto:20260211T180000", "DTEND;TZID=America/Toronto:20260211T200000",
	"LOCATION:MC 4021", "URL:https://example.edu/test1", "SEQUENCE:2",
	"ATTENDEE;CN=Prof:mailto:prof@example.edu", "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
	"LAST-MODIFIED:20260107T160506Z", "DTSTAMP:20260107T160506Z",
	"BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT30M", "DESCRIPTION:Reminder", "END:VALARM",
	"END:VEVENT", "END:VCALENDAR",
].join("\r\n");

const RECURRING = APPLE.replace("SEQUENCE:2", "SEQUENCE:2\r\nRRULE:FREQ=WEEKLY;BYDAY=TU");

const ev = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
	uid: "apple-1", title: "2214 Test 1", types: [], date: "2026-02-11",
	startTime: "18:00", endTime: "20:00", allDay: false, location: "MC 4021",
	timezone: TO, status: "confirmed", props: {}, path: "a.md", ...over,
});

test("an unchanged event yields no write at all", () => {
	const r = patchICS(APPLE, ev(), TO)!;
	assert.equal(r.changed, false);
	assert.equal(r.ics, APPLE);
});

test("editing the title keeps the alarm, attendee, URL and X-APPLE props", () => {
	const r = patchICS(APPLE, ev({ title: "2214 Test 1 (moved room)" }), TO)!;
	assert.equal(r.changed, true);
	for (const kept of ["BEGIN:VALARM", "TRIGGER:-PT30M", "ATTENDEE;CN=Prof", "URL:https://example.edu/test1",
		"X-APPLE-TRAVEL-ADVISORY-BEHAVIOR", "SEQUENCE:2"])
		assert.ok(r.ics.includes(kept), `lost ${kept}`);
	assert.equal(icsToEvent(r.ics, TO)!.title, "2214 Test 1 (moved room)");
});

test("a title edit does not rewrite untouched TZID timing", () => {
	const r = patchICS(APPLE, ev({ title: "Renamed" }), TO)!;
	assert.match(r.ics, /DTSTART;TZID=America\/Toronto:20260211T180000/);
});

test("changing the time rewrites timing but still keeps the alarm", () => {
	const r = patchICS(APPLE, ev({ startTime: "19:00", endTime: "21:00" }), TO)!;
	const parsed = icsToEvent(r.ics, TO)!;
	assert.equal(parsed.startTime, "19:00");
	assert.equal(parsed.endTime, "21:00");
	assert.ok(r.ics.includes("BEGIN:VALARM"));
	assert.ok(!/DTSTART;TZID/.test(r.ics), "stale TZID parameter left beside a UTC value");
});

test("clearing the location removes it without touching the rest", () => {
	const r = patchICS(APPLE, ev({ location: undefined }), TO)!;
	assert.ok(!r.ics.includes("LOCATION:"));
	assert.ok(r.ics.includes("BEGIN:VALARM"));
});

test("a series is never flattened by a note that does not know it repeats", () => {
	// The note predates rule parsing, or the user cleared the repeat: the two
	// are indistinguishable here, and guessing wrong loses the whole series.
	const r = patchICS(RECURRING, ev({ title: "Renamed" }), TO)!;
	assert.equal(r.pullOnly, true);
	assert.equal(r.changed, false);
	assert.equal(r.ics, RECURRING);
});

test("an unparseable server copy is refused, not overwritten", () => {
	assert.equal(patchICS("garbage", ev(), TO), null);
});

test("adds the type mirror without disturbing anything else", () => {
	const r = patchICS(APPLE, ev({ types: ["exam"], props: { weight: 45 } }), TO)!;
	assert.equal(r.changed, true);
	assert.deepEqual(icsToEvent(r.ics, TO)!.types, ["exam"]);
	assert.ok(r.ics.includes("BEGIN:VALARM"));
});

test("whitespace-only differences are not treated as edits", () => {
	const padded = APPLE.replace("SUMMARY:2214 Test 1", "SUMMARY:2214 Test 1 ")
		.replace("LOCATION:MC 4021", "LOCATION:MC 4021\\n");
	const r = patchICS(padded, ev(), TO)!;
	assert.equal(r.changed, false);
	assert.equal(r.ics, padded);
});

// --- series the plugin owns -------------------------------------------------

const WEEKLY = { freq: "weekly" as const, interval: 1, byDay: ["WE" as const] };
const series = (over: Partial<CalendarEvent> = {}) =>
	ev({ recurrence: { ...WEEKLY }, ...over });

test("an unchanged series with a readable rule yields no write", () => {
	const r = patchICS(RECURRING, series({ recurrence: { freq: "weekly", interval: 1, byDay: ["TU"] } }), TO)!;
	assert.equal(r.changed, false);
	assert.equal(r.pullOnly, false);
	assert.equal(r.ics, RECURRING);
});

test("a rule the plugin cannot read is refused rather than replaced", () => {
	const exotic = APPLE.replace("SEQUENCE:2", "SEQUENCE:2\r\nRRULE:FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO");
	const r = patchICS(exotic, series({ title: "Renamed" }), TO)!;
	assert.equal(r.pullOnly, true);
	assert.equal(r.changed, false);
	assert.equal(r.ics, exotic);
});

test("per-occurrence overrides make a series untouchable", () => {
	const withOverride = RECURRING.replace(
		"END:VCALENDAR",
		["BEGIN:VEVENT", "UID:apple-1", "RECURRENCE-ID;TZID=America/Toronto:20260218T180000",
			"DTSTART;TZID=America/Toronto:20260218T190000", "SUMMARY:2214 Test 1",
			"END:VEVENT", "END:VCALENDAR"].join("\r\n")
	);
	const r = patchICS(withOverride, series({ title: "Renamed" }), TO)!;
	assert.equal(r.pullOnly, true);
	assert.equal(r.ics, withOverride);
});

test("cancelling one occurrence writes an EXDATE and keeps the alarm", () => {
	const local = series({
		recurrence: { freq: "weekly", interval: 1, byDay: ["TU"] },
		exceptions: ["2026-02-17"],
	});
	const r = patchICS(RECURRING, local, TO)!;
	assert.equal(r.changed, true);
	assert.ok(r.ics.includes("BEGIN:VALARM"), "lost the alarm");
	assert.ok(r.ics.includes("RRULE:FREQ=WEEKLY;BYDAY=TU"), "lost or rewrote the rule");
	assert.deepEqual(icsToEvent(r.ics, TO)!.exceptions, ["2026-02-17"]);
});

test("an EXDATE matches DTSTART's form, so the server cannot ignore it", () => {
	const local = series({
		recurrence: { freq: "weekly", interval: 1, byDay: ["TU"] },
		exceptions: ["2026-02-17"],
	});
	const r = patchICS(RECURRING, local, TO)!;
	// DTSTART is TZID-qualified local time, so the exclusion must be too.
	assert.match(r.ics, /EXDATE;TZID=America\/Toronto:20260217T180000/);
});

test("restoring an occurrence removes its EXDATE", () => {
	const rule = { freq: "weekly" as const, interval: 1, byDay: ["TU" as const] };
	const withSkip = patchICS(RECURRING, series({ recurrence: rule, exceptions: ["2026-02-17"] }), TO)!;
	const restored = patchICS(withSkip.ics, series({ recurrence: rule }), TO)!;
	assert.equal(restored.changed, true);
	assert.equal(icsToEvent(restored.ics, TO)!.exceptions, undefined);
});

test("shortening a series rewrites only the rule", () => {
	const r = patchICS(
		RECURRING,
		series({ recurrence: { freq: "weekly", interval: 1, byDay: ["TU"], until: "2026-04-07" } }),
		TO
	)!;
	assert.equal(r.changed, true);
	assert.equal(icsToEvent(r.ics, TO)!.recurrence?.until, "2026-04-07");
	assert.ok(r.ics.includes("BEGIN:VALARM"));
	assert.match(r.ics, /DTSTART;TZID=America\/Toronto:20260211T180000/, "timing was rewritten");
});

test("moving a series in time rebuilds its exclusions against the new start", () => {
	const rule = { freq: "weekly" as const, interval: 1, byDay: ["TU" as const] };
	const r = patchICS(
		RECURRING,
		series({ recurrence: rule, exceptions: ["2026-02-17"], startTime: "19:00", endTime: "21:00" }),
		TO
	)!;
	assert.equal(r.changed, true);
	// A stale exclusion at the old hour would line up with no occurrence and
	// would quietly stop excluding anything.
	assert.ok(!r.ics.includes("T180000"), "an exclusion still points at the old time");
	assert.deepEqual(icsToEvent(r.ics, TO)!.exceptions, ["2026-02-17"]);
});

test("a brand new series is written with its rule and exclusions", () => {
	const ics = eventToICS(
		series({ recurrence: { freq: "weekly", interval: 1, byDay: ["MO", "WE"], until: "2026-04-08" },
			exceptions: ["2026-02-16"] }),
		TO
	);
	const parsed = icsToEvent(ics, TO)!;
	assert.equal(parsed.recurring, true);
	assert.deepEqual(parsed.recurrence?.byDay, ["MO", "WE"]);
	assert.equal(parsed.recurrence?.until, "2026-04-08");
	assert.deepEqual(parsed.exceptions, ["2026-02-16"]);
});

test("an all-day series excludes whole dates, not instants", () => {
	const ics = eventToICS(
		ev({ allDay: true, startTime: undefined, endTime: undefined,
			recurrence: { freq: "weekly", interval: 1, byDay: ["WE"] }, exceptions: ["2026-02-18"] }),
		TO
	);
	assert.match(ics, /EXDATE;VALUE=DATE:20260218/);
	assert.deepEqual(icsToEvent(ics, TO)!.exceptions, ["2026-02-18"]);
});

// --- a series repeats against the wall clock, not against an instant --------

test("a weekly class keeps its hour across the spring clock change", () => {
	const ics = eventToICS(
		series({
			date: "2026-01-05",
			startTime: "10:00",
			endTime: "11:20",
			recurrence: { freq: "weekly", interval: 1, byDay: ["MO"], until: "2026-04-08" },
		}),
		TO
	);

	// Registers the emitted VTIMEZONE, which is what makes the TZID mean
	// something to the iterator below.
	icsToEvent(ics, TO);
	assert.match(ics, /DTSTART;TZID=America\/Toronto:20260105T100000/);
	assert.ok(ics.includes("BEGIN:VTIMEZONE"), "a TZID with no definition is what servers misread");

	const vevent = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent("vevent")!;
	const iterator = new ICAL.Event(vevent).iterator();
	const hours = new Set<number>();
	for (let next = iterator.next(); next; next = iterator.next()) hours.add(next.hour);

	// Stored as a UTC instant this set would be {10, 11}: the March change
	// would walk every later class an hour forward.
	assert.deepEqual([...hours], [10], "the series drifted at the clock change");
});

test("a one-off event is still written as an unambiguous instant", () => {
	const ics = eventToICS(ev(), TO);
	assert.match(ics, /DTSTART:20260211T230000Z/);
	assert.ok(!ics.includes("BEGIN:VTIMEZONE"));
});

test("an event in an unknown zone falls back to floating rather than guessing", () => {
	const ics = eventToICS(series({ timezone: "Mars/Olympus" }), "Mars/Olympus");
	assert.ok(!ics.includes("BEGIN:VTIMEZONE"));
	assert.match(ics, /DTSTART:20260211T180000\r?\n/, "expected a floating local time");
});

test("an escaped type mirror reads back intact and does not rewrite the event", () => {
	// iCloud stores our X- mirror as proper escaped TEXT: what we send as
	// `personal,work` comes back as `personal\\,work`. Reading it raw produced a
	// type literally called "personal\\", and made the comparison differ on every
	// pass, so a multi-typed event was rewritten on every single sync.
	const typed = ev({ types: ["personal", "work"], props: { course: "CS 3600", weight: 45 } });
	// Built from our own writer, then escaped the way Apple escapes it, so the
	// fixture cannot drift away from what the plugin actually sends.
	const stored = eventToICS(typed, TO).replace(/^(X-TYPEDCAL-[A-Z]+:.*)$/gm, (line) =>
		line.replace(/,/g, "\\,")
	);
	assert.ok(stored.includes("\\,"), "the fixture is escaped like the server's copy");

	const parsed = icsToEvent(stored, TO);
	assert.deepEqual(parsed?.types, ["personal", "work"]);
	assert.deepEqual(parsed?.props, { course: "CS 3600", weight: 45 });

	const same = patchICS(stored, typed, TO);
	assert.equal(same?.changed, false, "the server already agrees; nothing to send");

	const changed = patchICS(stored, ev({ types: ["personal"], props: { course: "CS 3600", weight: 45 } }), TO);
	assert.equal(changed?.changed, true, "a real difference is still detected");
});

test("a type mirror round-trips through an event with several types", () => {
	const ics = eventToICS(ev({ types: ["personal", "work"], props: { a: 1, b: 2 } }), TO);
	const parsed = icsToEvent(ics, TO);
	assert.deepEqual(parsed?.types, ["personal", "work"]);
	assert.deepEqual(parsed?.props, { a: 1, b: 2 });
});
