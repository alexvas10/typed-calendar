import { readFileSync } from "node:fs";
import { autoMapCalendars, CalendarRouter } from "../src/sync/routing";

const d = JSON.parse(readFileSync("data.json", "utf8"));
const { types, mappings, created } = autoMapCalendars(d.eventTypes, d.caldav.calendars);

console.log("mappings that would be created:");
for (const m of mappings) console.log("  " + m);
console.log("\nnew types created: " + (created.join(", ") || "none"));

console.log("\nresulting type table:");
for (const t of types.sort((a, b) => b.rank - a.rank)) {
	const cal = d.caldav.calendars.find((c: { url: string; displayName: string }) => c.url === t.icloudCalendar);
	console.log(`  ${t.label.padEnd(14)} rank=${String(t.rank).padEnd(3)} -> ${cal?.displayName ?? "(vault only)"}`);
}

const router = new CalendarRouter(types, "");
console.log("\nrouting examples:");
for (const tags of [["exam", "cs3600"], ["assignment"], ["personal"], ["cs3600"], []]) {
	const url = router.routeFor({ types: tags } as never);
	const cal = d.caldav.calendars.find((c: { url: string; displayName: string }) => c.url === url);
	console.log(`  [${tags.join(", ") || "no types"}]`.padEnd(24) + " -> " + (cal?.displayName ?? "not pushed"));
}
