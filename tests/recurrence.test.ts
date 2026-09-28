import assert from "node:assert/strict";
import test from "node:test";
import {
	describeRecurrence,
	expandOccurrences,
	parseExceptions,
	parseRecurrence,
	positionInMonth,
	positionModeOf,
	positionRule,
	recurrenceToFrontmatter,
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

test("byDay reads positioned weekdays alongside plain ones", () => {
	assert.deepEqual(parseRecurrence({ freq: "monthly", byDay: ["2tu", "-1FR"] }), {
		freq: "monthly",
		interval: 1,
		byNthDay: [{ nth: -1, day: "FR" }, { nth: 2, day: "TU" }],
	});
	// The last weekday of the month: every weekday, narrowed to the last one.
	assert.deepEqual(
		parseRecurrence({ freq: "monthly", byDay: "MO,TU,WE,TH,FR", bySetPos: -1 }),
		{ freq: "monthly", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"], bySetPos: [-1] }
	);
});

test("parts a frequency cannot carry are dropped, not guessed at", () => {
	// A position on a weekly rule has nothing to position within.
	assert.deepEqual(parseRecurrence({ freq: "weekly", byDay: ["2TU", "WE"] }), {
		freq: "weekly",
		interval: 1,
		byDay: ["WE"],
	});
	// A yearly "second Tuesday" without a month would be the second Tuesday
	// of the year; the day part goes and a plain yearly rule remains.
	assert.deepEqual(parseRecurrence({ freq: "yearly", byDay: ["2TU"] }), {
		freq: "yearly",
		interval: 1,
	});
	assert.deepEqual(parseRecurrence({ freq: "monthly", byDay: ["9TU"], byMonthDay: [0, 40] }), {
		freq: "monthly",
		interval: 1,
	});
});

test("a positioned rule survives a frontmatter round trip", () => {
	const rule = parseRecurrence({ freq: "yearly", byMonth: [11], byDay: ["4TH"] })!;
	assert.deepEqual(recurrenceToFrontmatter(rule), {
		freq: "yearly", interval: 1, byDay: ["4TH"], byMonth: [11],
	});
	assert.deepEqual(parseRecurrence(recurrenceToFrontmatter(rule)), rule);
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
		"FREQ=WEEKLY;BYSETPOS=1;BYDAY=MO",
		"FREQ=WEEKLY;BYDAY=2MO",
		"FREQ=WEEKLY;INTERVAL=2;WKST=MO",
		"FREQ=DAILY;BYDAY=MO,TU",
		"FREQ=MONTHLY;BYMONTH=3",
		"FREQ=MONTHLY;BYDAY=6TU",
		"FREQ=MONTHLY;BYMONTHDAY=0",
		"FREQ=MONTHLY;BYSETPOS=1",
		"FREQ=YEARLY;BYDAY=20MO",
		"FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO",
		"FREQ=YEARLY;BYYEARDAY=100",
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

// --- positional rules ---------------------------------------------------------

const H1 = { from: "2026-01-01", to: "2026-06-30" };

test("the second Tuesday lands on the second Tuesday of every month", () => {
	const dates = expandOccurrences(
		"2026-01-13",
		{ freq: "monthly", interval: 1, byNthDay: [{ nth: 2, day: "TU" }] },
		[],
		H1
	);
	assert.deepEqual(dates, [
		"2026-01-13", "2026-02-10", "2026-03-10", "2026-04-14", "2026-05-12", "2026-06-09",
	]);
});

test("the last Friday counts back from the end of each month", () => {
	const dates = expandOccurrences(
		"2026-01-30",
		{ freq: "monthly", interval: 1, byNthDay: [{ nth: -1, day: "FR" }] },
		[],
		H1
	);
	assert.deepEqual(dates, [
		"2026-01-30", "2026-02-27", "2026-03-27", "2026-04-24", "2026-05-29", "2026-06-26",
	]);
});

test("the last weekday of the month is every weekday narrowed by set position", () => {
	// Apple's "On the last weekday": BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1.
	const rule = parseRRule("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", TO)!;
	assert.deepEqual(expandOccurrences("2026-01-30", rule, [], H1), [
		"2026-01-30", "2026-02-27", "2026-03-31", "2026-04-30", "2026-05-29", "2026-06-30",
	]);
});

test("a fifth Friday is skipped in months that have only four", () => {
	const dates = expandOccurrences(
		"2026-01-30",
		{ freq: "monthly", interval: 1, byNthDay: [{ nth: 5, day: "FR" }] },
		[],
		{ from: "2026-01-01", to: "2026-12-31" }
	);
	assert.deepEqual(dates, ["2026-01-30", "2026-05-29", "2026-07-31", "2026-10-30"]);
});

test("month days and weekdays intersect: Friday the 13th", () => {
	const rule = parseRRule("FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13", TO)!;
	assert.deepEqual(
		expandOccurrences("2026-02-13", rule, [], { from: "2026-01-01", to: "2027-12-31" }),
		["2026-02-13", "2026-03-13", "2026-11-13", "2027-08-13"]
	);
});

test("the 1st and 15th, and the last day of the month", () => {
	assert.deepEqual(
		expandOccurrences("2026-01-01", { freq: "monthly", interval: 1, byMonthDay: [1, 15] }, [], {
			from: "2026-01-01",
			to: "2026-02-28",
		}),
		["2026-01-01", "2026-01-15", "2026-02-01", "2026-02-15"]
	);
	assert.deepEqual(
		expandOccurrences("2026-01-31", { freq: "monthly", interval: 1, byMonthDay: [-1] }, [], {
			from: "2026-01-01",
			to: "2026-04-30",
		}),
		["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]
	);
});

test("an interval skips whole months of a positional rule", () => {
	const dates = expandOccurrences(
		"2026-01-13",
		{ freq: "monthly", interval: 2, byNthDay: [{ nth: 2, day: "TU" }] },
		[],
		H1
	);
	assert.deepEqual(dates, ["2026-01-13", "2026-03-10", "2026-05-12"]);
});

test("a yearly positional rule: the fourth Thursday of November", () => {
	const rule = parseRRule("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", TO)!;
	assert.deepEqual(
		expandOccurrences("2026-11-26", rule, [], { from: "2026-01-01", to: "2029-12-31" }),
		["2026-11-26", "2027-11-25", "2028-11-23", "2029-11-22"]
	);
});

test("count and exceptions behave on a positional rule as on any other", () => {
	const rule = { freq: "monthly" as const, interval: 1, byNthDay: [{ nth: 2, day: "TU" as const }], count: 3 };
	assert.deepEqual(expandOccurrences("2026-01-13", rule, ["2026-02-10"], H1), [
		"2026-01-13", "2026-03-10",
	]);
});

test("a positional rule long underway still renders this month", () => {
	const dates = expandOccurrences(
		"2010-01-12",
		{ freq: "monthly", interval: 1, byNthDay: [{ nth: 2, day: "TU" }] },
		[],
		{ from: "2026-03-01", to: "2026-03-31" }
	);
	assert.deepEqual(dates, ["2026-03-10"]);
});

test("positional RRULEs round-trip, whatever order the server wrote them in", () => {
	for (const rrule of [
		"FREQ=MONTHLY;BYDAY=2TU",
		"FREQ=MONTHLY;BYDAY=-1FR",
		"FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2",
		"FREQ=MONTHLY;BYMONTHDAY=1,15",
		"FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=-1",
		"FREQ=YEARLY;BYMONTH=11;BYDAY=4TH",
		"FREQ=YEARLY;BYMONTH=3,9",
	]) {
		const rule = parseRRule(rrule, TO);
		assert.ok(rule, `refused ${rrule}`);
		const again = parseRRule(formatRRule(rule, TO, false), TO);
		assert.deepEqual(again, rule, `${rrule} did not survive a round trip`);
	}
	// Same rule, different spelling: not an edit.
	assert.ok(
		sameRule(
			parseRRule("FREQ=MONTHLY;BYDAY=FR,MO;BYSETPOS=-1", TO)!,
			parseRRule("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,FR;WKST=SU", TO)!,
			TO,
			false
		)
	);
});

test("positional rules are described the way a person would say them", () => {
	assert.equal(
		describeRecurrence({ freq: "monthly", interval: 1, byNthDay: [{ nth: 2, day: "TU" }] }),
		"Every month on the 2nd Tue"
	);
	assert.equal(
		describeRecurrence({ freq: "monthly", interval: 1, byNthDay: [{ nth: -1, day: "FR" }] }),
		"Every month on the last Fri"
	);
	assert.equal(
		describeRecurrence({
			freq: "monthly", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"], bySetPos: [-1],
		}),
		"Every month on the last weekday"
	);
	assert.equal(
		describeRecurrence({ freq: "monthly", interval: 1, byMonthDay: [1, 15] }),
		"Every month on the 1st and the 15th"
	);
	assert.equal(
		describeRecurrence({
			freq: "yearly", interval: 1, byMonth: [11], byNthDay: [{ nth: 4, day: "TH" }],
		}),
		"Every year in Nov on the 4th Thu"
	);
});

test("the editor's options are worked out from the start date", () => {
	// 31 Mar 2026 is the fifth, and so the last, Tuesday.
	assert.deepEqual(positionInMonth("2026-03-31"), { nth: 5, day: "TU", isLast: true });
	assert.deepEqual(positionInMonth("2026-03-24"), { nth: 4, day: "TU", isLast: false });

	const monthly = { freq: "monthly" as const, interval: 1, until: "2026-12-31" };
	const nth = positionRule(monthly, "nth", "2026-03-24");
	assert.deepEqual(nth, { ...monthly, byNthDay: [{ nth: 4, day: "TU" }] });
	assert.equal(positionModeOf(nth, "2026-03-24"), "nth");
	assert.equal(positionModeOf(positionRule(monthly, "last", "2026-03-31"), "2026-03-31"), "last");
	assert.equal(positionModeOf(monthly, "2026-03-24"), "day");
	assert.equal(
		positionModeOf({ ...monthly, byMonthDay: [1, 15] }, "2026-03-24"),
		"custom",
		"a rule the editor did not build is not rebuilt by it"
	);

	const yearly = positionRule({ freq: "yearly", interval: 1 }, "nth", "2026-11-26");
	assert.deepEqual(yearly, {
		freq: "yearly", interval: 1, byNthDay: [{ nth: 4, day: "TH" }], byMonth: [11],
	});
});

test("a plain weekly rule with no weekdays repeats every week from its start", () => {
	// The shape of the user's fall-2024 courses: FREQ=WEEKLY, no BYDAY. It used
	// to draw as a single event, because stepping had no weekly case.
	const cs1020 = parseRecurrence({ freq: "weekly", interval: 1, until: "2024-12-02" })!;
	const dates = expandOccurrences("2024-10-07", cs1020, [], { from: "2024-10-01", to: "2024-12-31" });
	assert.equal(dates.length, 9);
	assert.deepEqual(dates.slice(0, 3), ["2024-10-07", "2024-10-14", "2024-10-21"]);
	assert.equal(dates[dates.length - 1], "2024-12-02");

	// Every other week, and a window long after the start (skip-ahead).
	const biweekly = { freq: "weekly" as const, interval: 2 };
	assert.deepEqual(expandOccurrences("2024-10-07", biweekly, [], { from: "2026-01-01", to: "2026-01-31" }),
		["2026-01-12", "2026-01-26"]);
	// And a counted one walks from the start.
	assert.deepEqual(expandOccurrences("2026-02-04", { freq: "weekly", interval: 1, count: 3 }, [], { from: "2026-01-01", to: "2026-12-31" }),
		["2026-02-04", "2026-02-11", "2026-02-18"]);
});
