import { DOMParser } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
(globalThis as Record<string, unknown>).DOMParser = DOMParser;

const { CalDavClient } = await import("../src/sync/caldav");

const cfg = JSON.parse(readFileSync("data.json", "utf8")).caldav;
const client = new CalDavClient(cfg.serverUrl, cfg.username, cfg.password);

const calendars = await client.discoverCalendars();
console.log(`discovered ${calendars.length} calendar(s):`);
for (const c of calendars) {
	console.log(`  ${c.displayName.padEnd(28)} readOnly=${String(c.readOnly).padEnd(5)} ${c.url}`);
}

if (calendars.length > 0) {
	const target = calendars.find((c) => !c.readOnly) ?? calendars[0];
	const resources = await client.listResources(target.url);
	console.log(`\n"${target.displayName}" holds ${resources.length} resource(s)`);
	const sample = await client.multiget(target.url, resources.slice(0, 2).map((r) => r.href));
	const { icsToEvent } = await import("../src/sync/ics");
	for (const obj of sample) {
		const ev = icsToEvent(obj.data, "America/Toronto");
		console.log(`  -> ${ev?.date ?? "?"} ${ev?.startTime ?? "all-day"} ${ev?.title}${ev?.recurring ? " [recurring]" : ""}`);
	}
}
