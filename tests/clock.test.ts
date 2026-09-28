import assert from "node:assert/strict";
import test from "node:test";
import {
	durationMinutes, formatClock, formatDuration, fromMinutes, parseClock, PRESET_DURATIONS
} from "../src/util/clock";

test("times are shown the way people say them", () => {
	assert.equal(formatClock("20:08"), "8:08 pm");
	assert.equal(formatClock("12:00"), "12:00 pm");
	assert.equal(formatClock("00:00"), "12:00 am");
	assert.equal(formatClock("00:30"), "12:30 am");
	assert.equal(formatClock("09:05"), "9:05 am");
});

test("typed times are read in every common form", () => {
	const cases: Record<string, string> = {
		"8": "08:00", "8am": "08:00", "8 pm": "20:00", "8pm": "20:00", "8:30": "08:30",
		"830": "08:30", "0830": "08:30", "20:30": "20:30", "8.30 p.m.": "20:30",
		"12am": "00:00", "12pm": "12:00", "12:15 am": "00:15", "noon": "12:00",
		"midnight": "00:00", "  9:45PM ": "21:45", "8p": "20:00",
	};
	for (const [typed, expected] of Object.entries(cases)) {
		assert.equal(parseClock(typed), expected, `"${typed}"`);
	}
});

test("nonsense is refused, not guessed at", () => {
	for (const typed of ["", "25", "13pm", "0am", "8:60", "abc", "8:3", "12345"]) {
		assert.equal(parseClock(typed), null, `"${typed}" should not parse`);
	}
});

test("durations wrap past midnight and are labelled plainly", () => {
	assert.equal(durationMinutes("08:00", "09:30"), 90);
	assert.equal(durationMinutes("23:00", "01:00"), 120);
	assert.equal(fromMinutes(23 * 60 + 90), "00:30");
	assert.deepEqual(PRESET_DURATIONS.map(formatDuration), [
		"30 min", "1 hour", "1½ hours", "2 hours", "2½ hours", "3 hours", "3½ hours", "4 hours",
	]);
	assert.equal(formatDuration(75), "1 h 15 min");
});
