import assert from "node:assert/strict";
import test from "node:test";
import ICAL from "ical.js";
import { buildVTimezone } from "../src/sync/vtimezone";
import { utcOffsetMinutes, wallClockToUtc } from "../src/util/timezone";

/**
 * Checks a generated VTIMEZONE against Intl on the 15th of every month: what
 * a calendar reading the definition would compute, against the real offset.
 * Read through an unregistered ICAL.Timezone, so no case leaks into another.
 */
function check(zone: string, year: number): void {
	const component = buildVTimezone(zone, year);
	assert.ok(component, `${zone} ${year}: no definition built`);
	const definition = new ICAL.Timezone(component);
	for (let month = 1; month <= 12; month++) {
		const wall = { year, month, day: 15, hour: 18, minute: 0 };
		const expected = utcOffsetMinutes(wallClockToUtc(wall, zone), zone);
		const actual = definition.utcOffset(ICAL.Time.fromData({ ...wall, second: 0 })) / 60;
		assert.equal(actual, expected, `${zone} ${year}-${String(month).padStart(2, "0")}-15`);
	}
}

test("a zone with no clock changes is one offset all year", () => {
	for (const zone of ["Asia/Shanghai", "Asia/Tokyo", "Africa/Nairobi", "UTC"]) check(zone, 2026);
});

test("half- and quarter-hour zones keep their odd offsets", () => {
	for (const zone of ["Asia/Kolkata", "Asia/Kathmandu", "Australia/Adelaide"]) check(zone, 2026);
});

test("northern-hemisphere daylight saving is right before the spring change", () => {
	for (const zone of ["America/Toronto", "America/Los_Angeles", "Europe/London", "Europe/Berlin"]) {
		check(zone, 2026);
	}
});

test("southern-hemisphere daylight saving is right in its January summer", () => {
	for (const zone of ["Australia/Sydney", "Pacific/Auckland", "America/Santiago"]) check(zone, 2026);
});

test("a year in which the rules changed is still covered from 1 January", () => {
	// The US moved its clock changes in 2007; Mexico dropped daylight saving
	// after 2022; Brazil after 2019.
	check("America/Toronto", 2007);
	check("America/Mexico_City", 2023);
	check("America/Sao_Paulo", 2020);
});
