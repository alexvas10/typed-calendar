import assert from "node:assert/strict";
import test from "node:test";
import {
	describeRecurrence,
	expandOccurrences,
	parseExceptions,
	parseRecurrence,
} from "../src/model/recurrence";
import { formatRRule, parseRRule, sameRule } from "../src/sync/rrule";

const TO = "America/Toronto";
const TERM = { from: "2026-01-01", to: "2026-04-30" };

// A real Monday/Wednesday/Friday class: 5 Jan is a Monday, 8 Apr a Wednesday.
const MWF = { freq: "weekly" as const, interval: 1, byDay: ["MO", "WE", "FR"] as const };

test("a weekly class lands on every one of its days", () => {
	const dates = expandOccurrences("2026-01-05", { ...MWF, byDay: [...MWF.byDay] }, [], {
		from: "2026-01-01",
		to: "2026-01-18",
	});
	assert.deepEqual(dates, [
		"2026-01-05", "2026-01-07", "2026-01-09",
		"2026-01-12", "2026-01-14", "2026-01-16",
	]);
});

test("until is inclusive, so the last class is not lost", () => {
	const dates = expandOccurrences(
		"2026-01-05",
		{ ...MWF, byDay: [...MWF.byDay], until: "2026-04-08" },
		[],
		TERM
	);
	assert.equal(dates[dates.length - 1], "2026-04-08");
});

test("an excepted date is removed and the rest of the series is untouched", () => {
	const all = expandOccurrences("2026-01-05", { ...MWF, byDay: [...MWF.byDay] }, [], TERM);
	const skipped = expandOccurrences(
		"2026-01-05",
		{ ...MWF, byDay: [...MWF.byDay] },
		["2026-02-16", "2026-02-18", "2026-02-20"],
		TERM
	);
	assert.equal(skipped.length, all.length - 3);
	assert.ok(!skipped.includes("2026-02-16"));
	// Removing an occurrence must not shift the series along by one.
	assert.deepEqual(skipped.slice(0, 6), all.slice(0, 6));
	assert.equal(skipped[skipped.length - 1], all[all.length - 1]);
});

test("the start date is kept even when the rule does not land on it", () => {
	// 6 Jan is a Tuesday; the rule says Mon/Wed/Fri.
	const dates = expandOccurrences("2026-01-06", { ...MWF, byDay: [...MWF.byDay] }, [], {
		from: "2026-01-01",
		to: "2026-01-10",
	});
	assert.deepEqual(dates, ["2026-01-06", "2026-01-07", "2026-01-09"]);
});

test("an interval skips whole weeks rather than occurrences", () => {
	const dates = expandOccurrences(
		"2026-01-05",
		{ freq: "weekly", interval: 2, byDay: ["MO"] },
		[],
		{ from: "2026-01-01", to: "2026-02-10" }
	);
	assert.deepEqual(dates, ["2026-01-05", "2026-01-19", "2026-02-02"]);
});

test("count bounds the series and ignores the window", () => {
	const dates = expandOccurrences("2026-01-05", { freq: "daily", interval: 1, count: 3 }, [], {
		from: "2026-01-01",
		to: "2026-12-31",
	});
	assert.deepEqual(dates, ["2026-01-05", "2026-01-06", "2026-01-07"]);
});

test("a monthly rule skips months that have no such day", () => {
	const dates = expandOccurrences("2026-01-31", { freq: "monthly", interval: 1 }, [], {
		from: "2026-01-01",
		to: "2026-05-01",
	});
	// No 31 February and no 31 April.
	assert.deepEqual(dates, ["2026-01-31", "2026-03-31"]);
});

test("an unbounded rule is bounded by the window, not by patience", () => {
	const dates = expandOccurrences("2020-01-01", { freq: "daily", interval: 1 }, [], {
		from: "2026-01-01",
		to: "2026-01-05",
	});
	assert.deepEqual(dates, ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]);
});

test("a single event expands to itself, or to nothing once excepted", () => {
	assert.deepEqual(expandOccurrences("2026-01-05", undefined, [], TERM), ["2026-01-05"]);
	assert.deepEqual(expandOccurrences("2026-01-05", undefined, ["2026-01-05"], TERM), []);
});

// --- frontmatter ---

test("a hand-written recurrence block is read leniently", () => {
	const rule = parseRecurrence({ freq: "Weekly", byDay: "mo,we", until: "2026-04-08" });
	assert.deepEqual(rule, { freq: "weekly", interval: 1, byDay: ["MO", "WE"], until: "2026-04-08" });
});

test("a block with no usable frequency is not a rule", () => {
	assert.equal(parseRecurrence({ interval: 2 }), null);
	assert.equal(parseRecurrence({ freq: "fortnightly" }), null);
	assert.equal(parseRecurrence("weekly"), null);
});

test("byDay is ignored where it would mean positioning", () => {
	// "the third Monday of the month" is outside the supported subset.
	assert.deepEqual(parseRecurrence({ freq: "monthly", byDay: ["MO"] }), {
		freq: "monthly",
		interval: 1,
	});
});

test("until wins over count, since they cannot both apply", () => {
	const rule = parseRecurrence({ freq: "weekly", until: "2026-04-08", count: 12 });
	assert.equal(rule?.until, "2026-04-08");
	assert.equal(rule?.count, undefined);
});

test("exceptions are normalised, deduplicated and sorted", () => {
	assert.deepEqual(parseExceptions(["2026-03-30", "2026-02-16", "2026-02-16"]), [
		"2026-02-16",
		"2026-03-30",
	]);
	assert.deepEqual(parseExceptions(undefined), []);
	assert.deepEqual(parseExceptions("2026-02-16"), ["2026-02-16"]);
});

// --- RRULE ---

test("a weekly RRULE survives a round trip", () => {
	const rule = parseRRule("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR;UNTIL=20260409T035959Z", TO);
	assert.equal(rule?.freq, "weekly");
	assert.deepEqual(rule?.byDay, ["MO", "WE", "FR"]);
	// The UNTIL instant is late evening in Toronto, so the local date is the 8th.
	assert.equal(rule?.until, "2026-04-08");
	assert.ok(sameRule(rule ?? undefined, parseRRule(formatRRule(rule!, TO, false), TO) ?? undefined, TO, false));
});

test("an until we write keeps the final occurrence", () => {
	const rrule = formatRRule({ freq: "weekly", interval: 1, byDay: ["WE"], until: "2026-04-08" }, TO, false);
	const reparsed = parseRRule(rrule, TO);
	assert.equal(reparsed?.until, "2026-04-08");
});

test("rules outside the writable subset are refused, not guessed at", () => {
	for (const rrule of [
		"FREQ=MONTHLY;BYDAY=2TU",
		"FREQ=MONTHLY;BYMONTHDAY=13",
		"FREQ=WEEKLY;BYSETPOS=1;BYDAY=MO",
		"FREQ=WEEKLY;INTERVAL=2;WKST=MO",
		"FREQ=HOURLY",
		"BYDAY=MO",
	]) {
		assert.equal(parseRRule(rrule, TO), null, `should not have accepted ${rrule}`);
	}
});

test("a plain weekly rule is accepted whatever WKST says, since it cannot differ", () => {
	assert.equal(parseRRule("FREQ=WEEKLY;WKST=MO;BYDAY=TU", TO)?.freq, "weekly");
});

test("an all-day until is written as a date, not an instant", () => {
	const rrule = formatRRule({ freq: "weekly", interval: 1, until: "2026-04-08" }, TO, true);
	assert.match(rrule, /UNTIL=20260408$/);
});

test("the human summary explains the ordering of a real class", () => {
	assert.equal(
		describeRecurrence({ freq: "weekly", interval: 1, byDay: ["MO", "WE", "FR"], until: "2026-04-08" }),
		"Every week on Mon, Wed, Fri, until 2026-04-08"
	);
	assert.equal(
		describeRecurrence({ freq: "weekly", interval: 2, byDay: ["TU"] }),
		"Every 2 weeks on Tue"
	);
});
