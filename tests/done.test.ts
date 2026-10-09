import assert from "node:assert/strict";
import test from "node:test";
import ICAL from "ical.js";
import { markTitle, readTitle } from "../src/sync/done";
import { eventToICS, icsToEvent, patchICS } from "../src/sync/ics";
import { mergeRemote, newEventFromRemote } from "../src/sync/plan";
import { sameMaster } from "../src/sync/remote";
import { eventBody as googleBody, readEvents as readGoogle, type GoogleEvent } from "../src/sync/google/mapping";
import { eventBody as outlookBody, readEvent as readOutlook, type GraphEvent } from "../src/sync/outlook/mapping";
import { applyEventToFrontmatter, eventFromFrontmatter } from "../src/model/serialize";
import { inEventFolders, normalizeFolderList, normalizeSettings } from "../src/settings/settings";
import { showsEvent } from "../src/model/types";
import type { CalendarEvent } from "../src/model/types";

const TO = "America/Toronto";

// A realistic Apple event, as in patch.test.ts: TZID times, an alarm, X-APPLE props.
const APPLE = [
	"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple Inc.//iOS 18//EN",
	"BEGIN:VEVENT", "UID:apple-1", "SUMMARY:Assignment 2",
	"DTSTART;TZID=America/Toronto:20260211T180000", "DTEND;TZID=America/Toronto:20260211T200000",
	"LOCATION:MC 4021", "SEQUENCE:2", "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
	"LAST-MODIFIED:20260107T160506Z", "DTSTAMP:20260107T160506Z",
	"BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT30M", "DESCRIPTION:Reminder", "END:VALARM",
	"END:VEVENT", "END:VCALENDAR",
].join("\r\n");

const ev = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
	uid: "apple-1", title: "Assignment 2", types: [], date: "2026-02-11",
	startTime: "18:00", endTime: "20:00", allDay: false, location: "MC 4021",
	timezone: TO, status: "confirmed", props: {}, path: "a.md", ...over,
});

const summaryOf = (ics: string) =>
	String(new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent("vevent")!.getFirstPropertyValue("summary"));

// --- the mark itself -----------------------------------------------------------

test("the mark goes on and comes off, never doubled", () => {
	assert.equal(markTitle("Essay", true), "✓ Essay");
	assert.equal(markTitle("✓ Essay", true), "✓ Essay");
	assert.equal(markTitle("✓ Essay", false), "Essay");
	assert.equal(markTitle("Essay", undefined), "Essay");
	assert.deepEqual(readTitle("✓ Essay"), { title: "Essay", done: true });
	assert.deepEqual(readTitle("✔️ Essay"), { title: "Essay", done: true }, "a phone keyboard's heavy check");
	assert.deepEqual(readTitle("✓"), { title: "✓", done: false }, "a bare mark is a title");
	assert.deepEqual(readTitle("✓done"), { title: "✓done", done: false });
	assert.deepEqual(readTitle(undefined), { title: "", done: false });
});

// --- notes -------------------------------------------------------------------------

test("done round-trips through a note, and only a literal true counts", () => {
	const fm: Record<string, unknown> = { tags: ["x"] };
	applyEventToFrontmatter(ev({ done: true }), fm);
	assert.equal(fm.done, true);
	assert.equal(eventFromFrontmatter(fm, "a.md", "a")!.done, true);
	applyEventToFrontmatter(ev({ done: undefined }), fm);
	assert.ok(!("done" in fm), "un-done removes the key");
	assert.equal(eventFromFrontmatter({ uid: "x", done: "yes" }, "a.md", "a")!.done, undefined);
});

test("views hide done events unless Show completed is on", () => {
	assert.equal(showsEvent(ev({ done: true }), [], false), false);
	assert.equal(showsEvent(ev({ done: true }), [], true), true);
	assert.equal(showsEvent(ev({ types: ["exam"] }), ["exam"], false), true);
	assert.equal(showsEvent(ev({ types: ["exam"], done: true }), ["class"], true), false, "the type filter still applies");
});

// --- extra folders -------------------------------------------------------------------

test("extra event folders are cleaned, and folder boundaries count", () => {
	assert.deepEqual(normalizeFolderList(["/Courses/", "Courses", "", 3, "Work"]), ["Courses", "Work"]);
	assert.deepEqual(normalizeSettings({}).extraEventFolders, []);
	assert.equal(normalizeSettings({}).showCompleted, false);
	const folders = ["Calendar/Events", "Courses"];
	assert.ok(inEventFolders("Courses/CS2212/Assessments/2026-02-27 Midterm.md", folders));
	assert.ok(inEventFolders("Calendar/Events/x.md", folders));
	assert.ok(!inEventFolders("Courses2/x.md", folders));
	assert.ok(!inEventFolders("Notes/x.md", folders));
	assert.ok(inEventFolders("anything.md", [""]), "an empty folder is the whole vault");
});

// --- iCloud ----------------------------------------------------------------------------

test("an event that is not done patches exactly as before: no write", () => {
	const r = patchICS(APPLE, ev(), TO)!;
	assert.equal(r.changed, false);
	assert.equal(r.ics, APPLE);
});

test("crossing off writes the mark, keeps the alarm, and reads back as done", () => {
	const r = patchICS(APPLE, ev({ done: true }), TO)!;
	assert.equal(r.changed, true);
	assert.equal(summaryOf(r.ics), "✓ Assignment 2");
	for (const kept of ["BEGIN:VALARM", "TRIGGER:-PT30M", "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR", "SEQUENCE:2"]) {
		assert.ok(r.ics.includes(kept), `lost ${kept}`);
	}
	const parsed = icsToEvent(r.ics, TO)!;
	assert.equal(parsed.title, "Assignment 2", "the note keeps the plain title");
	assert.equal(parsed.done, true);

	// The next sync of the unchanged done event is a no-op, not a rewrite.
	const again = patchICS(r.ics, ev({ done: true }), TO)!;
	assert.equal(again.changed, false);
	assert.equal(again.ics, r.ics);

	// Un-doing takes the mark off.
	const undone = patchICS(r.ics, ev(), TO)!;
	assert.equal(undone.changed, true);
	assert.equal(summaryOf(undone.ics), "Assignment 2");
	assert.equal(icsToEvent(undone.ics, TO)!.done, undefined);
});

test("a title the server stores escaped still round-trips with the mark", () => {
	// Built from ical.js's own output, the way a server sends it back.
	const ics = eventToICS(ev({ title: "Essay, draft; part 2", done: true }), TO);
	assert.ok(ics.includes("SUMMARY:✓ Essay\\, draft\\; part 2"));
	const parsed = icsToEvent(ics, TO)!;
	assert.equal(parsed.title, "Essay, draft; part 2");
	assert.equal(parsed.done, true);
	assert.equal(patchICS(ics, ev({ title: "Essay, draft; part 2", done: true }), TO)!.changed, false);
});

test("ticking off on the phone (typing the mark) comes back as done", () => {
	const phone = APPLE.replace("SUMMARY:Assignment 2", "SUMMARY:✓ Assignment 2");
	const parsed = icsToEvent(phone, TO)!;
	assert.equal(parsed.done, true);
	const merged = mergeRemote(ev(), parsed, "/h.ics", "etag", "/cal/");
	assert.equal(merged.done, true);
	assert.equal(merged.title, "Assignment 2");
	// And un-ticking there clears it.
	assert.equal(mergeRemote({ ...ev(), done: true }, icsToEvent(APPLE, TO)!, "/h.ics", "e", "/cal/").done, undefined);
	assert.equal(newEventFromRemote(parsed, "icloud", "/h.ics", "e", "/cal/", (t) => t, TO, "u").done, true);
});

test("a done series marks its moved occurrences too, without inventing title overrides", () => {
	const weekly = APPLE.replace("SEQUENCE:2", "SEQUENCE:2\r\nRRULE:FREQ=WEEKLY;BYDAY=WE");
	const moved = [
		"BEGIN:VEVENT", "UID:apple-1", "RECURRENCE-ID;TZID=America/Toronto:20260218T180000",
		"DTSTART;TZID=America/Toronto:20260219T190000", "DTEND;TZID=America/Toronto:20260219T210000",
		"SUMMARY:Assignment 2", "LOCATION:DC 1350", "LAST-MODIFIED:20260107T160506Z", "DTSTAMP:20260107T160506Z",
		"END:VEVENT",
	].join("\r\n");
	const withMove = weekly.replace("END:VCALENDAR", `${moved}\r\nEND:VCALENDAR`);
	const move = { occurrence: "2026-02-18", date: "2026-02-19", startTime: "19:00", endTime: "21:00", location: "DC 1350" };
	const series = ev({ recurrence: { freq: "weekly", interval: 1, byDay: ["WE"] }, overrides: [move], done: true });

	const r = patchICS(withMove, series, TO)!;
	assert.equal(r.changed, true);
	const summaries = new ICAL.Component(ICAL.parse(r.ics)).getAllSubcomponents("vevent").map((c) => c.getFirstPropertyValue("summary"));
	assert.deepEqual(summaries, ["✓ Assignment 2", "✓ Assignment 2"]);
	const parsed = icsToEvent(r.ics, TO)!;
	assert.deepEqual(parsed.overrides, [move], "the mark is not a title change");
	assert.equal(patchICS(r.ics, series, TO)!.changed, false);
});

// --- Google and Outlook ---------------------------------------------------------------

test("Google: the mark is written, read back as done, and compared plain", () => {
	const body = googleBody(ev({ done: true }), TO);
	assert.equal(body.summary, "✓ Assignment 2");
	const phone: GoogleEvent = {
		id: "g1", etag: '"1"', status: "confirmed", summary: "✓ Assignment 2", updated: "2026-02-01T00:00:00.000Z",
		start: { dateTime: "2026-02-11T18:00:00-05:00", timeZone: TO }, end: { dateTime: "2026-02-11T20:00:00-05:00", timeZone: TO },
		location: "MC 4021",
	};
	const [item] = readGoogle([phone], TO);
	assert.equal(item.event.title, "Assignment 2");
	assert.equal(item.event.done, true);
	assert.ok(sameMaster(item.event, ev({ done: true })));
	assert.ok(!sameMaster(item.event, ev()), "done differs: a write is due");
});

test("Outlook: the mark is written, read back as done, and not an occurrence change", () => {
	assert.equal(outlookBody(ev({ done: true }), TO).subject, "✓ Assignment 2");
	const master: GraphEvent = {
		id: "o1", changeKey: "ck1", type: "singleInstance", subject: "✓ Assignment 2",
		start: { dateTime: "2026-02-11T18:00:00.0000000", timeZone: TO }, end: { dateTime: "2026-02-11T20:00:00.0000000", timeZone: TO },
		location: { displayName: "MC 4021" }, isAllDay: false, lastModifiedDateTime: "2026-02-01T00:00:00Z",
	};
	const item = readOutlook(master, [], { from: "2026-02-01", to: "2026-03-01" })!;
	assert.equal(item.event.title, "Assignment 2");
	assert.equal(item.event.done, true);
});

test("a note whose own title starts with the mark is not a change every sync", () => {
	const remote = icsToEvent(APPLE, TO)!;
	assert.ok(sameMaster(remote, ev({ title: "✓ Assignment 2" })));
});
