/**
 * Live push verification, run outside Obsidian.
 *
 * Exercises the real write path -- PUT with If-None-Match / If-Match, the 412
 * guard, patch-in-place, move between calendars, RRULE + VTIMEZONE and EXDATE
 * -- against the user's actual iCloud account, using only throwaway events in
 * the empty Home calendar (and Work, for the move).
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
