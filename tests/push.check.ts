/**
 * Live push verification, run outside Obsidian.
 *
 * Exercises the real write path -- PUT with If-None-Match / If-Match, the 412
 * guard, patch-in-place, move between calendars, RRULE + VTIMEZONE, EXDATE,
 * a changed single occurrence (RECURRENCE-ID) and a "2nd Tuesday" monthly
 * rule -- against the user's actual iCloud account, using only throwaway
 * events in the empty Home calendar (and Work, for the move).
 *
 * Safety: every href in Home and Work is recorded before anything is written,
 * the script refuses to PUT or DELETE any href it did not create itself, and
 * the final step asserts both calendars hold exactly the resources they
 * started with. Delete this file when the verification is done.
 */
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
(globalThis as Record<string, unknown>).DOMParser = DOMParser;

import ICAL from "ical.js";
const { CalDavClient, CalDavError } = await import("../src/sync/caldav");
const { eventToICS, icsToEvent, patchICS } = await import("../src/sync/ics");
const { expandOccurrences, positionInMonth } = await import("../src/model/recurrence");
const { utcToWallClock } = await import("../src/util/timezone");

const cfg = JSON.parse(readFileSync("data.json", "utf8"));
const client = new CalDavClient(cfg.caldav.serverUrl, cfg.caldav.username, cfg.caldav.password);
const TZ: string = cfg.defaultTimezone || "America/Toronto";

const HOME = cfg.caldav.calendars.find((c: any) => c.displayName === "Home");
const WORK = cfg.caldav.calendars.find((c: any) => c.displayName === "Work");
if (!HOME || !WORK) throw new Error("Home and Work calendars must both be configured.");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
	if (ok) console.log(`  ok   ${label}`);
	else {
		failures++;
		console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ""}`);
	}
}
function step(n: string): void {
	console.log(`\n${n}`);
}

/** Resources present before we touched anything; never write to these. */
const baseline = new Map<string, Set<string>>();
for (const cal of [HOME, WORK]) {
	const hrefs = new Set((await client.listResources(cal.url)).map((r) => r.href));
	baseline.set(cal.url, hrefs);
	console.log(`${cal.displayName}: ${hrefs.size} existing resource(s)`);
}

const mine = new Set<string>();
function guard(calUrl: string, href: string): void {
	if (baseline.get(calUrl)?.has(href)) {
		throw new Error(`REFUSING to touch a pre-existing resource: ${href}`);
	}
	mine.add(href);
}

const stamp = Date.now();
const uid = `tc-pushtest-${stamp}`;
const seriesUid = `tc-pushtest-series-${stamp}`;
const monthlyUid = `tc-pushtest-monthly-${stamp}`;

function iso(daysFromNow: number): string {
	const d = new Date();
	d.setDate(d.getDate() + daysFromNow);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** The next Monday strictly after today. */
function nextMonday(): string {
	const d = new Date();
	d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(date: string, n: number): string {
	const [y, m, d] = date.split("-").map(Number);
	const dt = new Date(y, m - 1, d + n);
	return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

const base: any = {
	uid,
	title: "Typed Calendar push test",
	types: ["personal"],
	date: iso(1),
	startTime: "15:00",
	endTime: "16:00",
	allDay: false,
	location: "Nowhere",
	timezone: TZ,
	status: "confirmed",
	props: {},
	path: "",
};

async function fetchOne(calUrl: string, href: string) {
	const [obj] = await client.multiget(calUrl, [href]);
	return obj;
}

let homeHref = `${HOME.url}${uid}.ics`;
try {
	// ---------------------------------------------------------------- 1. create
	step("1. create-remote: PUT a brand new event into Home");
	guard(HOME.url, homeHref);
	await client.put(homeHref, eventToICS(base, TZ));
	let obj = await fetchOne(HOME.url, homeHref);
	check("resource exists after PUT", Boolean(obj));
	let parsed = obj ? icsToEvent(obj.data, TZ) : null;
	check("title round-trips", parsed?.title === base.title, parsed?.title);
	check("date round-trips", parsed?.date === base.date, `${parsed?.date} vs ${base.date}`);
	check("start time round-trips", parsed?.startTime === "15:00", parsed?.startTime);
	check("end time round-trips", parsed?.endTime === "16:00", parsed?.endTime);
	check("types mirror survives", (parsed?.types ?? []).join(",") === "personal", String(parsed?.types));
	check("etag returned", Boolean(obj?.etag), obj?.etag);

	// ------------------------------------------------- 2. alarm survives a patch
	step("2. patch in place: an edit must not destroy anything else");
	// Give the server copy something the plugin does not model. This is the
	// exact class of data the regenerate-from-note bug destroyed.
	const withAlarm = obj!.data.replace(
		"END:VEVENT",
		"BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT"
	);
	await client.put(homeHref, withAlarm, obj!.etag);
	obj = await fetchOne(HOME.url, homeHref);
	check("alarm is on the server copy", obj!.data.includes("BEGIN:VALARM"));

	const edited = { ...base, title: "Typed Calendar push test (edited)", location: "Somewhere else" };
	const patch = patchICS(obj!.data, edited, TZ);
	check("patchICS parsed the server copy", Boolean(patch));
	check("patchICS reports a change", patch?.changed === true);
	check("patch keeps the alarm", Boolean(patch?.ics.includes("BEGIN:VALARM")));
	await client.put(homeHref, patch!.ics, obj!.etag);
	obj = await fetchOne(HOME.url, homeHref);
	parsed = icsToEvent(obj!.data, TZ);
	check("edited title is on the server", parsed?.title === edited.title, parsed?.title);
	check("edited location is on the server", parsed?.location === edited.location, parsed?.location);
	check("alarm survived the real write", obj!.data.includes("BEGIN:VALARM"));

	// ---------------------------------------------------------------- 3. no-op
	step("3. no-op: an unchanged note must send nothing");
	const again = patchICS(obj!.data, edited, TZ);
	check("patchICS reports no change", again?.changed === false);

	// ------------------------------------------------------------------ 4. 412
	step("4. If-Match guard: a stale ETag must be refused");
	let got412 = false;
	try {
		await client.put(homeHref, patch!.ics, '"staleetag12345"');
	} catch (error) {
		got412 = error instanceof CalDavError && error.status === 412;
		if (!got412) throw error;
	}
	check("stale ETag rejected with 412", got412);
	check("resource still readable after the refusal", Boolean(await fetchOne(HOME.url, homeHref)));

	// ----------------------------------------------------------------- 5. move
	step("5. move-remote: delete from Home, then create the carried body in Work");
	const current = await fetchOne(HOME.url, homeHref);
	const carried = patchICS(current!.data, { ...edited, types: ["work"] }, TZ);
	check("move body patched, not regenerated", Boolean(carried) && !carried!.pullOnly);
	const workHref = `${WORK.url}${uid}.ics`;
	guard(WORK.url, workHref);

	// iCloud enforces UID uniqueness across the whole calendar home, so the
	// destination create is refused while the source still exists. Prove that,
	// because it is the reason the delete has to come first.
	let collision = false;
	try {
		await client.put(workHref, carried!.ics);
	} catch (error) {
		collision = error instanceof CalDavError && error.status === 412;
		if (!collision) throw error;
	}
	check("create-before-delete is refused (UID is taken account-wide)", collision);

	await client.delete(homeHref, current!.etag);
	mine.delete(homeHref);
	await client.put(workHref, carried!.ics);
	const moved = await fetchOne(WORK.url, workHref);
	check("event is in Work", Boolean(moved));
	check("alarm survived the move", Boolean(moved?.data.includes("BEGIN:VALARM")));
	check("type mirror updated to work", (icsToEvent(moved!.data, TZ)?.types ?? []).join(",") === "work");
	const homeNow = await client.listResources(HOME.url);
	check("Home no longer holds it", !homeNow.some((r) => r.href === homeHref));
	check("Home is back to its baseline count", homeNow.length === baseline.get(HOME.url)!.size,
		`${homeNow.length} vs ${baseline.get(HOME.url)!.size}`);

	// --------------------------------------------------------- 6. delete-remote
	step("6. delete-remote");
	await client.delete(workHref, moved!.etag);
	mine.delete(workHref);
	const workNow = await client.listResources(WORK.url);
	check("Work is back to its baseline count", workNow.length === baseline.get(WORK.url)!.size,
		`${workNow.length} vs ${baseline.get(WORK.url)!.size}`);

	// ------------------------------------------------------------ 7. a series
	step("7. recurring: ONE resource carrying an RRULE and a VTIMEZONE");
	const monday = nextMonday();
	const series: any = {
		...base,
		uid: seriesUid,
		title: "Typed Calendar repeat test",
		date: monday,
		startTime: "10:00",
		endTime: "11:00",
		location: undefined,
		recurrence: { freq: "weekly", interval: 1, byDay: ["MO"], until: addDays(monday, 21) },
	};
	const seriesHref = `${HOME.url}${seriesUid}.ics`;
	guard(HOME.url, seriesHref);
	await client.put(seriesHref, eventToICS(series, TZ));
	let sobj = await fetchOne(HOME.url, seriesHref);
	check("series resource exists", Boolean(sobj));
	check("Home holds exactly ONE new resource, not four",
		(await client.listResources(HOME.url)).length === baseline.get(HOME.url)!.size + 1);
	check("body carries an RRULE", /^RRULE/m.test(sobj!.data.replace(/\r\n[ \t]/g, "")));
	check("body carries a VTIMEZONE", sobj!.data.includes("BEGIN:VTIMEZONE"));
	check("DTSTART is TZID-qualified, not a UTC instant",
		/DTSTART;TZID=/.test(sobj!.data), sobj!.data.match(/DTSTART[^\r\n]*/)?.[0]);
	const sparsed = icsToEvent(sobj!.data, TZ);
	check("rule reads back as weekly/MO", sparsed?.recurrence?.freq === "weekly" &&
		(sparsed?.recurrence?.byDay ?? []).join(",") === "MO", JSON.stringify(sparsed?.recurrence));
	check("series is NOT pull-only", Boolean(sparsed?.recurrence));

	// What Apple will actually show: expand the server's own copy.
	const occurrencesOf = (ics: string): string[] => {
		const comp = new ICAL.Component(ICAL.parse(ics));
		for (const vt of comp.getAllSubcomponents("vtimezone")) {
			const zone = new ICAL.Timezone(vt);
			if (!ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone);
		}
		const ev = new ICAL.Event(comp.getAllSubcomponents("vevent")[0]);
		const it = ev.iterator();
		const out: string[] = [];
		for (let next = it.next(); next && out.length < 20; next = it.next()) {
			out.push(`${next.toString().slice(0, 16)}`);
		}
		return out;
	};
	const occ = occurrencesOf(sobj!.data);
	console.log(`     occurrences: ${occ.join("  ")}`);
	check("four weekly occurrences", occ.length === 4, String(occ.length));
	check("every occurrence is at 10:00", occ.every((o) => o.endsWith("T10:00")), occ.join(","));

	// ------------------------------------------------------------ 8. an EXDATE
	step("8. skip one occurrence: EXDATE written and honoured");
	const skipped = addDays(monday, 14);
	const withEx = patchICS(sobj!.data, { ...series, exceptions: [skipped] }, TZ);
	check("patch adds the exclusion", withEx?.changed === true);
	await client.put(seriesHref, withEx!.ics, sobj!.etag);
	sobj = await fetchOne(HOME.url, seriesHref);
	check("EXDATE is on the server", /EXDATE/.test(sobj!.data), sobj!.data.match(/EXDATE[^\r\n]*/)?.[0]);
	check("exclusion reads back as the right date",
		(icsToEvent(sobj!.data, TZ)?.exceptions ?? []).join(",") === skipped,
		JSON.stringify(icsToEvent(sobj!.data, TZ)?.exceptions));
	const afterSkip = occurrencesOf(sobj!.data);
	console.log(`     occurrences: ${afterSkip.join("  ")}`);
	check("three occurrences remain", afterSkip.length === 3, String(afterSkip.length));
	check("the skipped date is gone", !afterSkip.some((o) => o.startsWith(skipped)));
	check("the others kept their time", afterSkip.every((o) => o.endsWith("T10:00")));

	step("9. restore the occurrence");
	const restored = patchICS(sobj!.data, { ...series, exceptions: [] }, TZ);
	check("patch removes the exclusion", restored?.changed === true);
	await client.put(seriesHref, restored!.ics, sobj!.etag);
	sobj = await fetchOne(HOME.url, seriesHref);
	check("no EXDATE left", !/EXDATE/.test(sobj!.data));
	check("four occurrences again", occurrencesOf(sobj!.data).length === 4);

	step("10. a note that forgot its rule must NOT flatten the series");
	const amnesiac = patchICS(sobj!.data, { ...series, recurrence: undefined }, TZ);
	check("patchICS refuses", amnesiac?.pullOnly === true && amnesiac?.changed === false);
	check("and returns the body untouched", amnesiac?.ics === sobj!.data);

	// ------------------------------------------- 11. change ONE occurrence
	/**
	 * The occurrences Apple would show, overrides applied: each as
	 * "YYYY-MM-DDTHH:MM" in the event's own zone, plus "@location" when it
	 * has one. A moved occurrence is written as a UTC instant while the series
	 * is wall-clock time, so a UTC start is converted before printing, or 14:00
	 * in Toronto reads as 18:00. ical.js is an
	 * independent RFC 5545 implementation, so agreeing with it is a real check
	 * on the RECURRENCE-ID we wrote, not a check of our code against itself.
	 */
	const shown = (ics: string): string[] => {
		const comp = new ICAL.Component(ICAL.parse(ics));
		for (const vt of comp.getAllSubcomponents("vtimezone")) {
			const zone = new ICAL.Timezone(vt);
			if (!ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone);
		}
		const vevents = comp.getAllSubcomponents("vevent");
		const master = new ICAL.Event(vevents.find((v) => !v.hasProperty("recurrence-id")));
		for (const v of vevents) if (v.hasProperty("recurrence-id")) master.relateException(v);
		const it = master.iterator();
		const out: string[] = [];
		for (let next = it.next(); next && out.length < 20; next = it.next()) {
			const details = master.getOccurrenceDetails(next);
			const where = details.item.location ? `@${details.item.location}` : "";
			const start = details.startDate;
			const wall = start.zone?.tzid === "UTC"
				? (({ date, time }) => `${date}T${time}`)(utcToWallClock(start.toJSDate().valueOf(), TZ))
				: start.toString().slice(0, 16);
			out.push(`${wall}${where}`);
		}
		return out.sort();
	};

	step("11. change one occurrence: move week 2 to Tuesday 14:00 in another room");
	// Give the series an alarm first: a detached occurrence must carry it too,
	// or the moved class would silently lose its reminder.
	const withSeriesAlarm = sobj!.data.replace(
		"END:VEVENT",
		"BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT"
	);
	await client.put(seriesHref, withSeriesAlarm, sobj!.etag);
	sobj = await fetchOne(HOME.url, seriesHref);

	const week2 = addDays(monday, 7);
	const move = { occurrence: week2, date: addDays(week2, 1), startTime: "14:00", endTime: "15:00", location: "Room B" };
	const withMove = patchICS(sobj!.data, { ...series, overrides: [move] }, TZ);
	check("patch adds the changed occurrence", withMove?.changed === true && !withMove.pullOnly);
	await client.put(seriesHref, withMove!.ics, sobj!.etag);
	sobj = await fetchOne(HOME.url, seriesHref);
	check("still ONE resource in Home",
		(await client.listResources(HOME.url)).length === baseline.get(HOME.url)!.size + 1);
	check("server holds a RECURRENCE-ID component", /^RECURRENCE-ID/m.test(sobj!.data),
		sobj!.data.match(/RECURRENCE-ID[^\r\n]*/)?.[0]);
	check("the change reads back exactly",
		JSON.stringify(icsToEvent(sobj!.data, TZ)?.overrides) === JSON.stringify([move]),
		JSON.stringify(icsToEvent(sobj!.data, TZ)?.overrides));
	const afterMove = shown(sobj!.data);
	console.log(`     occurrences: ${afterMove.join("  ")}`);
	check("four occurrences, one of them moved", afterMove.length === 4, String(afterMove.length));
	check("week 2 is on Tuesday at 14:00 in Room B", afterMove.includes(`${addDays(week2, 1)}T14:00@Room B`));
	check("week 2's Monday slot is empty", !afterMove.some((o) => o.startsWith(week2)));
	check("the other weeks are untouched at 10:00",
		afterMove.filter((o) => o.endsWith("T10:00")).length === 3);
	const detached = new ICAL.Component(ICAL.parse(sobj!.data)).getAllSubcomponents("vevent")
		.find((v) => v.hasProperty("recurrence-id"));
	check("the moved occurrence carries the series' alarm", Boolean(detached?.getFirstSubcomponent("valarm")));

	step("12. edit the changed occurrence: patched in place, then a no-op");
	const renamed = { ...move, location: "Room C" };
	const roomEdit = patchICS(sobj!.data, { ...series, overrides: [renamed] }, TZ);
	check("patch changes only the room", roomEdit?.changed === true);
	await client.put(seriesHref, roomEdit!.ics, sobj!.etag);
	sobj = await fetchOne(HOME.url, seriesHref);
	check("room is Room C on the server", shown(sobj!.data).includes(`${addDays(week2, 1)}T14:00@Room C`));
	const settled = patchICS(sobj!.data, { ...series, overrides: [renamed] }, TZ);
	check("an unchanged note now sends nothing", settled?.changed === false);

	step("13. reset the occurrence to the series");
	const reset = patchICS(sobj!.data, { ...series, overrides: undefined }, TZ);
	check("patch removes the change", reset?.changed === true);
	await client.put(seriesHref, reset!.ics, sobj!.etag);
	sobj = await fetchOne(HOME.url, seriesHref);
	check("no RECURRENCE-ID left", !/^RECURRENCE-ID/m.test(sobj!.data));
	const afterReset = shown(sobj!.data);
	check("four Mondays at 10:00 again",
		afterReset.length === 4 && afterReset.every((o) => o.endsWith("T10:00")), afterReset.join(","));
	check("the series alarm survived all of it", sobj!.data.includes("TRIGGER:-PT10M"));

	// -------------------------------------------- 14. a "2nd Tuesday" series
	step("14. monthly positional rule: the 2nd Tuesday, three times");
	// The next second Tuesday strictly after today.
	let first = addDays(iso(1), 0);
	while (!(positionInMonth(first).day === "TU" && positionInMonth(first).nth === 2)) first = addDays(first, 1);
	const monthly: any = {
		...base,
		uid: monthlyUid,
		title: "Typed Calendar monthly test",
		date: first,
		startTime: "09:00",
		endTime: "10:00",
		location: undefined,
		recurrence: { freq: "monthly", interval: 1, byNthDay: [{ nth: 2, day: "TU" }], count: 3 },
	};
	const monthlyHref = `${HOME.url}${monthlyUid}.ics`;
	guard(HOME.url, monthlyHref);
	await client.put(monthlyHref, eventToICS(monthly, TZ));
	const mobj = await fetchOne(HOME.url, monthlyHref);
	check("monthly resource exists", Boolean(mobj));
	check("rule on the server is BYDAY=2TU",
		/^RRULE:.*BYDAY=2TU/m.test(mobj!.data), mobj!.data.match(/^RRULE[^\r\n]*/m)?.[0]);
	const mparsed = icsToEvent(mobj!.data, TZ);
	check("rule reads back unchanged",
		JSON.stringify(mparsed?.recurrence) === JSON.stringify(monthly.recurrence),
		JSON.stringify(mparsed?.recurrence));
	const theirs = shown(mobj!.data).map((o) => o.slice(0, 10));
	const ours = expandOccurrences(first, monthly.recurrence, [], { from: first, to: addDays(first, 120) });
	console.log(`     ical.js: ${theirs.join("  ")}`);
	console.log(`     plugin:  ${ours.join("  ")}`);
	check("the plugin and ical.js agree on every date", theirs.join(",") === ours.join(","));
	check("every date is a Tuesday in the 2nd week",
		theirs.every((d) => positionInMonth(d).day === "TU" && positionInMonth(d).nth === 2));
	check("an unchanged note sends nothing", patchICS(mobj!.data, monthly, TZ)?.changed === false);
} finally {
	step("cleanup");
	for (const href of Array.from(mine)) {
		for (const cal of [HOME, WORK]) {
			if (!href.startsWith(cal.url)) continue;
			try {
				await client.delete(href);
				console.log(`  removed ${href.split("/").pop()}`);
			} catch (error) {
				console.log(`  COULD NOT REMOVE ${href}: ${String(error)}`);
				failures++;
			}
		}
	}
	for (const cal of [HOME, WORK]) {
		const now = await client.listResources(cal.url);
		const before = baseline.get(cal.url)!;
		const added = now.filter((r) => !before.has(r.href));
		const gone = Array.from(before).filter((h) => !now.some((r) => r.href === h));
		check(`${cal.displayName} is exactly as we found it`,
			added.length === 0 && gone.length === 0,
			`added ${added.length}, missing ${gone.length}`);
	}
	console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
	process.exit(failures === 0 ? 0 : 1);
}
