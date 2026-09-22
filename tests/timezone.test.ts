import assert from "node:assert/strict";
import test from "node:test";
import {
	wallClockToUtc, utcToWallClock, toWallClock, isValidTimezone,
} from "../src/util/timezone";

const TO = "America/Toronto";

test("converts a winter wall time to UTC (EST, -5)", () => {
	const ms = wallClockToUtc({ year: 2026, month: 1, day: 15, hour: 14, minute: 0 }, TO);
	assert.equal(new Date(ms).toISOString(), "2026-01-15T19:00:00.000Z");
});

test("converts a summer wall time to UTC (EDT, -4)", () => {
	const ms = wallClockToUtc({ year: 2026, month: 7, day: 15, hour: 14, minute: 0 }, TO);
	assert.equal(new Date(ms).toISOString(), "2026-07-15T18:00:00.000Z");
});

test("round-trips across the spring-forward boundary", () => {
	// 2026-03-08 is the US/Canada DST start; 03:00 local is the first valid time.
	const ms = wallClockToUtc({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 }, TO);
	assert.deepEqual(utcToWallClock(ms, TO), { date: "2026-03-08", time: "03:30" });
});

test("round-trips across the fall-back boundary", () => {
	const ms = wallClockToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, TO);
	const back = utcToWallClock(ms, TO);
	// The hour repeats, so only the date and minute are unambiguous.
	assert.equal(back.date, "2026-11-01");
	assert.equal(back.time.endsWith(":30"), true);
});

test("round-trips an ordinary event in several zones", () => {
	for (const tz of [TO, "Europe/Berlin", "Asia/Tokyo", "Australia/Adelaide", "UTC"]) {
		const ms = wallClockToUtc({ year: 2026, month: 10, day: 14, hour: 14, minute: 0 }, tz);
		assert.deepEqual(utcToWallClock(ms, tz), { date: "2026-10-14", time: "14:00" },
			`round trip failed for ${tz}`);
	}
});

test("handles a half-hour offset zone", () => {
	const ms = wallClockToUtc({ year: 2026, month: 6, day: 1, hour: 9, minute: 0 }, "Asia/Kolkata");
	assert.equal(new Date(ms).toISOString(), "2026-06-01T03:30:00.000Z");
});

test("midnight does not roll onto the previous day", () => {
	const ms = wallClockToUtc({ year: 2026, month: 10, day: 14, hour: 0, minute: 0 }, TO);
	assert.equal(utcToWallClock(ms, TO).date, "2026-10-14");
});

test("toWallClock defaults a missing time to midnight and rejects junk", () => {
	assert.deepEqual(toWallClock("2026-10-14", undefined),
		{ year: 2026, month: 10, day: 14, hour: 0, minute: 0 });
	assert.equal(toWallClock("oct 14", "14:00"), null);
});

test("validates timezone names", () => {
	assert.equal(isValidTimezone(TO), true);
	assert.equal(isValidTimezone("Mars/Olympus"), false);
});
