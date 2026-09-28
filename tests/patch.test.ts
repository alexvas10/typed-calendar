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
	const exotic = APPLE.replace("SEQUENCE:2", "SEQUENCE:2\r\nRRULE:FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO");
	const r = patchICS(exotic, series({ title: "Renamed" }), TO)!;
	assert.equal(r.pullOnly, true);
	assert.equal(r.changed, false);
	assert.equal(r.ics, exotic);
});

// --- per-occurrence overrides --------------------------------------------------

// A Wednesday class, with the 18 Feb lecture moved to Thursday evening in
// another room -- the way Apple stores it: a second VEVENT with the same UID
// and a RECURRENCE-ID naming the occurrence it replaces, carrying its own alarm.
const WEDNESDAYS = APPLE.replace("SEQUENCE:2", "SEQUENCE:2\r\nRRULE:FREQ=WEEKLY;BYDAY=WE");
const MOVED_COMPONENT = [
	"BEGIN:VEVENT", "UID:apple-1", "RECURRENCE-ID;TZID=America/Toronto:20260218T180000",
	"DTSTART;TZID=America/Toronto:20260219T190000", "DTEND;TZID=America/Toronto:20260219T210000",
	"SUMMARY:2214 Test 1", "LOCATION:DC 1350", "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
	"LAST-MODIFIED:20260107T160506Z", "DTSTAMP:20260107T160506Z",
	"BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:Moved", "END:VALARM",
	"END:VEVENT",
].join("\r\n");
const WITH_MOVE = WEDNESDAYS.replace("END:VCALENDAR", `${MOVED_COMPONENT}\r\nEND:VCALENDAR`);
const MOVE = {
	occurrence: "2026-02-18", date: "2026-02-19", startTime: "19:00", endTime: "21:00",
	location: "DC 1350",
};
const wednesdays = (over: Partial<CalendarEvent> = {}) =>
	series({ recurrence: { ...WEEKLY }, ...over });

/** The RECURRENCE-ID components of a body, in document order. */
const instances = (ics: string) =>
	new ICAL.Component(ICAL.parse(ics))
		.getAllSubcomponents("vevent")
		.filter((component) => component.getFirstPropertyValue("recurrence-id"));

test("a moved occurrence is read as just what differs from the series", () => {
	const parsed = icsToEvent(WITH_MOVE, TO)!;
	assert.ok(parsed.recurrence, "a series with an override is no longer pull-only");
	assert.deepEqual(parsed.overrides, [MOVE]);
	assert.equal(parsed.title, "2214 Test 1", "the master is still the series");
});

test("a series whose overrides already match is not rewritten", () => {
	const r = patchICS(WITH_MOVE, wednesdays({ overrides: [{ ...MOVE }] }), TO)!;
	assert.equal(r.changed, false);
	assert.equal(r.pullOnly, false);
	assert.equal(r.ics, WITH_MOVE);
});

test("renaming the series carries into the moved occurrence and keeps its alarm", () => {
	const r = patchICS(WITH_MOVE, wednesdays({ title: "2214 Lecture", overrides: [{ ...MOVE }] }), TO)!;
	assert.equal(r.changed, true);
	const [moved] = instances(r.ics);
	assert.equal(moved.getFirstPropertyValue("summary"), "2214 Lecture");
	assert.equal(moved.getFirstPropertyValue("location"), "DC 1350");
	assert.ok(moved.getFirstSubcomponent("valarm"), "the occurrence lost its own alarm");
	assert.ok(r.ics.includes("TRIGGER:-PT30M"), "the series lost its alarm");
	assert.deepEqual(icsToEvent(r.ics, TO)!.overrides, [MOVE]);
});

test("changing a moved occurrence edits its component in place", () => {
	const r = patchICS(
		WITH_MOVE,
		wednesdays({ overrides: [{ ...MOVE, location: "MC 1085" }] }),
		TO
	)!;
	assert.equal(r.changed, true);
	const [moved] = instances(r.ics);
	assert.equal(moved.getFirstPropertyValue("location"), "MC 1085");
	assert.match(r.ics, /DTSTART;TZID=America\/Toronto:20260219T190000/, "untouched timing was rewritten");
	assert.ok(r.ics.includes("X-APPLE-TRAVEL-ADVISORY-BEHAVIOR"), "lost the component's own properties");
});

test("resetting an occurrence to the series removes its component", () => {
	const r = patchICS(WITH_MOVE, wednesdays(), TO)!;
	assert.equal(r.changed, true);
	assert.equal(instances(r.ics).length, 0);
	assert.ok(r.ics.includes("TRIGGER:-PT30M"), "the series lost its alarm");
	assert.equal(icsToEvent(r.ics, TO)!.overrides, undefined);
});

test("moving one occurrence adds a component that names it the way DTSTART does", () => {
	const move = { occurrence: "2026-02-25", startTime: "20:00", endTime: "21:30" };
	const r = patchICS(WEDNESDAYS, wednesdays({ overrides: [move] }), TO)!;
	assert.equal(r.changed, true);
	// DTSTART is TZID-qualified local time; a UTC RECURRENCE-ID would be
	// within the server's rights to match nothing.
	assert.match(r.ics, /RECURRENCE-ID;TZID=America\/Toronto:20260225T180000/);
	const [added] = instances(r.ics);
	assert.ok(added.getFirstSubcomponent("valarm"), "a detached occurrence should keep the series' alarm");
	assert.deepEqual(icsToEvent(r.ics, TO)!.overrides, [move]);
	assert.ok(r.ics.includes("RRULE:FREQ=WEEKLY;BYDAY=WE"), "lost or rewrote the rule");
});

test("retiming the series re-points every RECURRENCE-ID at the new start", () => {
	const r = patchICS(
		WITH_MOVE,
		wednesdays({ startTime: "17:00", endTime: "19:00", overrides: [{ ...MOVE }] }),
		TO
	)!;
	assert.equal(r.changed, true);
	assert.match(r.ics, /RECURRENCE-ID;TZID=America\/Toronto:20260218T170000/);
	assert.deepEqual(icsToEvent(r.ics, TO)!.overrides, [MOVE]);
});

test("an override that changes nothing modelled survives, so its alarm does too", () => {
	// Only the alarm differs on this occurrence. Reading it as "no override"
	// would make the next push delete the component, and the alarm with it.
	const alarmOnly = WEDNESDAYS.replace(
		"END:VCALENDAR",
		MOVED_COMPONENT.replace("DTSTART;TZID=America/Toronto:20260219T190000", "DTSTART;TZID=America/Toronto:20260218T180000")
			.replace("DTEND;TZID=America/Toronto:20260219T210000", "DTEND;TZID=America/Toronto:20260218T200000")
			.replace("LOCATION:DC 1350", "LOCATION:MC 4021") + "\r\nEND:VCALENDAR"
	);
	const parsed = icsToEvent(alarmOnly, TO)!;
	assert.deepEqual(parsed.overrides, [{ occurrence: "2026-02-18" }]);
	const r = patchICS(alarmOnly, wednesdays({ overrides: parsed.overrides }), TO)!;
	assert.equal(r.changed, false);
});

test("an override for a date the series does not produce is never written", () => {
	// 17 Feb is a Tuesday; the class meets on Wednesdays.
	const r = patchICS(WEDNESDAYS, wednesdays({ overrides: [{ occurrence: "2026-02-17", location: "X" }] }), TO)!;
	assert.equal(r.changed, false);
	assert.equal(instances(r.ics).length, 0);
});

test("a skipped occurrence is not changed, but its server copy is not deleted either", () => {
	// Skipping through the plugin drops the override from the note first, so
	// the component goes on the next write (see the reset test). An entry
	// still listed beside an exclusion is left exactly as the server has it:
	// deleting a change made in Apple Calendar should take a deliberate reset.
	const r = patchICS(
		WITH_MOVE,
		wednesdays({ exceptions: ["2026-02-18"], overrides: [{ ...MOVE, location: "Elsewhere" }] }),
		TO
	)!;
	assert.deepEqual(icsToEvent(r.ics, TO)!.exceptions, ["2026-02-18"]);
	const [kept] = instances(r.ics);
	assert.equal(kept.getFirstPropertyValue("location"), "DC 1350", "an inert override was edited");
});

test("a series whose override names a date the rule does not produce stays pull-only", () => {
	// 17 Feb is a Tuesday; this series meets on Wednesdays. The server and the
	// plugin disagree about the series, so the plugin must not own it.
	const stray = WEDNESDAYS.replace(
		"END:VCALENDAR",
		MOVED_COMPONENT.replace("RECURRENCE-ID;TZID=America/Toronto:20260218T180000",
			"RECURRENCE-ID;TZID=America/Toronto:20260217T180000") + "\r\nEND:VCALENDAR"
	);
	assert.equal(icsToEvent(stray, TO)!.recurrence, undefined);
	const r = patchICS(stray, wednesdays({ title: "Renamed" }), TO)!;
	assert.equal(r.pullOnly, true);
	assert.equal(r.ics, stray);
});

test("Apple's moved first occurrence: DTSTART off-rule, moved onto a rule day", () => {
	// The shape of the user's CS1027: DTSTART on a Monday, rule TU/TH, the
	// Monday occurrence moved to Tuesday and that Tuesday's own occurrence
	// excluded. The start date is always an occurrence, so this is readable.
	const series = [
		"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple Inc.//macOS//EN",
		"BEGIN:VEVENT", "UID:cs1027", "SUMMARY:CS1027",
		"DTSTART;TZID=America/Toronto:20250106T123000", "DTEND;TZID=America/Toronto:20250106T133000",
		"RRULE:FREQ=WEEKLY;UNTIL=20250405T035959Z;BYDAY=TU,TH",
		"EXDATE;TZID=America/Toronto:20250107T123000",
		"END:VEVENT",
		"BEGIN:VEVENT", "UID:cs1027", "RECURRENCE-ID;TZID=America/Toronto:20250106T123000",
		"DTSTART;TZID=America/Toronto:20250107T123000", "DTEND;TZID=America/Toronto:20250107T133000",
		"SUMMARY:CS1027", "END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
	const parsed = icsToEvent(series, TO)!;
	assert.deepEqual(parsed.overrides, [{ occurrence: "2025-01-06", date: "2025-01-07" }]);
	const note = {
		...ev({ uid: "cs1027", title: "CS1027", date: "2025-01-06", startTime: "12:30", endTime: "13:30",
			location: undefined }),
		recurrence: parsed.recurrence, exceptions: parsed.exceptions, overrides: parsed.overrides,
	};
	const r = patchICS(series, note, TO)!;
	assert.equal(r.changed, false, "an unedited finished course must not be rewritten");
});

test("the master is found even when an override component comes first", () => {
	const overrideFirst = WEDNESDAYS.replace(
		"BEGIN:VEVENT",
		`${MOVED_COMPONENT}\r\nBEGIN:VEVENT`
	);
	const r = patchICS(overrideFirst, wednesdays({ title: "Renamed", overrides: [{ ...MOVE }] }), TO)!;
	const parsed = icsToEvent(r.ics, TO)!;
	assert.equal(parsed.title, "Renamed");
	assert.equal(parsed.date, "2026-02-11", "the override was edited as if it were the series");
	assert.deepEqual(parsed.overrides, [MOVE]);
});

test("overrides that rewrite the rest of the series stay out of reach", () => {
	for (const component of [
		MOVED_COMPONENT.replace("RECURRENCE-ID;TZID", "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID"),
		MOVED_COMPONENT.replace("LOCATION:DC 1350", "LOCATION:DC 1350\r\nSTATUS:CANCELLED"),
	]) {
		const body = WEDNESDAYS.replace("END:VCALENDAR", `${component}\r\nEND:VCALENDAR`);
		assert.equal(icsToEvent(body, TO)!.recurrence, undefined);
		const r = patchICS(body, wednesdays({ title: "Renamed" }), TO)!;
		assert.equal(r.pullOnly, true);
		assert.equal(r.ics, body);
	}
});

test("a brand new series is written with its overrides", () => {
	const ics = eventToICS(
		wednesdays({ overrides: [{ ...MOVE }, { occurrence: "2026-03-04", title: "Guest lecture" }] }),
		TO
	);
	assert.equal(instances(ics).length, 2);
	assert.deepEqual(icsToEvent(ics, TO)!.overrides, [
		MOVE,
		{ occurrence: "2026-03-04", title: "Guest lecture" },
	]);
});

test("an all-day series names its occurrences by date", () => {
	const ics = eventToICS(
		ev({ allDay: true, startTime: undefined, endTime: undefined,
			recurrence: { freq: "weekly", interval: 1, byDay: ["WE"] },
			overrides: [{ occurrence: "2026-02-18", date: "2026-02-20" }] }),
		TO
	);
	assert.match(ics, /RECURRENCE-ID;VALUE=DATE:20260218/);
	assert.deepEqual(icsToEvent(ics, TO)!.overrides, [{ occurrence: "2026-02-18", date: "2026-02-20" }]);
});

test("a monthly positional series patches without touching its rule", () => {
	const monthly = APPLE.replace("SEQUENCE:2", "SEQUENCE:2\r\nRRULE:FREQ=MONTHLY;BYDAY=WE;BYSETPOS=2");
	const parsed = icsToEvent(monthly, TO)!;
	assert.deepEqual(parsed.recurrence, { freq: "monthly", interval: 1, byDay: ["WE"], bySetPos: [2] });
	const r = patchICS(monthly, series({ title: "Renamed", recurrence: parsed.recurrence }), TO)!;
	assert.equal(r.changed, true);
	assert.equal(r.pullOnly, false);
	// Spelled the server's way, not ours: the rule was not edited, so it is
	// not rewritten.
	assert.ok(r.ics.includes("RRULE:FREQ=MONTHLY;BYDAY=WE;BYSETPOS=2"));
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

test("a series that starts before the spring change reads back at its own hour", () => {
	// The generated VTIMEZONE used to begin at the year's first clock change,
	// leaving the weeks before it undefined: an 18:00 class read back as 13:00,
	// and a pull would have written that into the note. Other zones are
	// covered in vtimezone.test.ts.
	for (const date of ["2026-01-05", "2026-02-11", "2026-07-08", "2026-12-02"]) {
		const parsed = icsToEvent(
			eventToICS(series({ date, recurrence: { freq: "weekly", interval: 1 } }), TO),
			TO
		)!;
		assert.equal(parsed.startTime, "18:00", `${date} came back at ${parsed.startTime}`);
		assert.equal(parsed.endTime, "20:00");
	}
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

test("a locked event is refused by the patcher too, whatever the caller", () => {
	const r = patchICS(APPLE, ev({ title: "Renamed", readOnly: true }), TO)!;
	assert.equal(r.pullOnly, true);
	assert.equal(r.changed, false);
	assert.equal(r.ics, APPLE);
});
