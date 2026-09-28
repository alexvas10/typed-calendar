import { addDays, weekdayOf } from "../util/dates";

/**
 * Repeat rules, expressed as the subset of RFC 5545 recurrence this plugin is
 * prepared to author.
 *
 * The subset is deliberate rather than lazy. A rule the plugin can parse is a
 * rule it can also write back, and writing back a rule we only half understood
 * is how a calendar loses data. It covers what Apple Calendar's own editor can
 * produce -- weekdays, "the second Tuesday", "the last weekday", "the 1st and
 * 15th", "the fourth Thursday of November" -- and nothing past it: BYWEEKNO,
 * BYYEARDAY, sub-daily frequencies and RDATE are left to the server, and such
 * a series is pulled, displayed, and never written. See `parseRRule`.
 */

export type Frequency = "daily" | "weekly" | "monthly" | "yearly";

/** RFC 5545 weekday codes, in week order starting Sunday. */
export const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** "The second Tuesday" is { nth: 2, day: "TU" }; "the last Friday" is -1. */
export interface NthWeekday {
	/** 1 to 5 counting from the start of the month, -1 to -5 from its end. */
	nth: number;
	day: Weekday;
}

export interface RecurrenceRule {
	freq: Frequency;
	/** Repeat every N periods. Always >= 1. */
	interval: number;
	/**
	 * Weekly: the days of the week it meets on; empty means "the start day".
	 * Monthly and yearly: every such weekday in the month, which on its own is
	 * rarely wanted and is normally narrowed by `bySetPos` -- the "last
	 * weekday of the month" is MO-FR with a set position of -1.
	 */
	byDay?: Weekday[];
	/** Monthly and yearly: positioned weekdays, e.g. the second Tuesday. */
	byNthDay?: NthWeekday[];
	/** Monthly and yearly: days of the month; -1 is the last day. */
	byMonthDay?: number[];
	/** Yearly only: which months, 1-12. Required by any yearly day part. */
	byMonth?: number[];
	/**
	 * Monthly and yearly: picks the nth date out of those the other parts
	 * produce in one period, counting from the end when negative.
	 */
	bySetPos?: number[];
	/** Last date the series may fall on, inclusive. */
	until?: string;
	/** Total occurrences the rule generates. Mutually exclusive with `until`. */
	count?: number;
}

/** Hard ceiling on an expansion, so an unbounded rule cannot hang a render. */
const MAX_OCCURRENCES = 2000;

const FREQ_BY_NAME: Record<string, Frequency> = {
	daily: "daily",
	weekly: "weekly",
	monthly: "monthly",
	yearly: "yearly",
};

const DAY_ENTRY = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/;

/**
 * Reads one BYDAY entry: "TU" is a plain weekday, "2TU" and "-1FR" are
 * positioned. Returns null for anything else, including a zero or
 * out-of-range position.
 */
export function parseDayEntry(value: unknown): Weekday | NthWeekday | null {
	const match = String(value ?? "").trim().toUpperCase().match(DAY_ENTRY);
	if (!match) return null;
	const day = match[2] as Weekday;
	if (match[1] === undefined) return day;
	const nth = Number(match[1]);
	return nth !== 0 && Math.abs(nth) <= 5 ? { nth, day } : null;
}

export function formatDayEntry(entry: Weekday | NthWeekday): string {
	return typeof entry === "string" ? entry : `${entry.nth}${entry.day}`;
}

function asDate(value: unknown): string | undefined {
	if (value instanceof Date && !isNaN(value.valueOf())) {
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
	}
	const match = String(value ?? "").trim().match(/^(\d{4})-?(\d{2})-?(\d{2})/);
	return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

/** A YAML list, a single scalar, or a comma-separated string. */
function asList(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value === "string") return value.split(",");
	return value === undefined || value === null ? [] : [value];
}

/** Integers within +/-limit, zero excluded, deduplicated and sorted. */
function asIntegers(value: unknown, limit: number, allowNegative = true): number[] {
	const out = new Set<number>();
	for (const entry of asList(value)) {
		const n = Number(String(entry).trim());
		if (!Number.isInteger(n) || n === 0 || Math.abs(n) > limit) continue;
		if (n < 0 && !allowNegative) continue;
		out.add(n);
	}
	return Array.from(out).sort((a, b) => a - b);
}

/**
 * Reads a `recurrence:` block off frontmatter. Returns null for anything that
 * is not a rule we can both honour and write back, so a hand-written oddity
 * degrades to a single event rather than to a wrong series.
 *
 * Parts that do not apply to the frequency are dropped rather than refused,
 * the same leniency the rest of the frontmatter gets: a weekly rule that also
 * names a month is still a perfectly good weekly rule.
 */
export function parseRecurrence(value: unknown): RecurrenceRule | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;

	const freq = FREQ_BY_NAME[String(raw.freq ?? raw.frequency ?? "").trim().toLowerCase()];
	if (!freq) return null;

	const intervalRaw = Number(raw.interval ?? 1);
	const interval = Number.isFinite(intervalRaw) && intervalRaw >= 1 ? Math.floor(intervalRaw) : 1;

	const rule: RecurrenceRule = { freq, interval };

	const plain: Weekday[] = [];
	const nth: NthWeekday[] = [];
	for (const entry of asList(raw.byDay)) {
		const parsed = parseDayEntry(entry);
		if (typeof parsed === "string") plain.push(parsed);
		else if (parsed) nth.push(parsed);
	}
	if (plain.length > 0) rule.byDay = plain;
	if (nth.length > 0) rule.byNthDay = nth;

	const byMonthDay = asIntegers(raw.byMonthDay, 31);
	if (byMonthDay.length > 0) rule.byMonthDay = byMonthDay;
	const byMonth = asIntegers(raw.byMonth, 12, false);
	if (byMonth.length > 0) rule.byMonth = byMonth;
	const bySetPos = asIntegers(raw.bySetPos, 31);
	if (bySetPos.length > 0) rule.bySetPos = bySetPos;

	const until = asDate(raw.until ?? raw.endDate);
	if (until) rule.until = until;

	const count = Number(raw.count);
	// UNTIL and COUNT are mutually exclusive in RFC 5545; a note carrying both
	// keeps the end date, which is the one a person actually reasoned about.
	if (!until && Number.isFinite(count) && count >= 1) rule.count = Math.floor(count);

	return canonicalRule(dropInapplicable(rule));
}

/** Removes the parts a frequency cannot carry. See `ruleProblem`. */
function dropInapplicable(rule: RecurrenceRule): RecurrenceRule {
	const out = { ...rule };
	if (out.freq === "daily") {
		delete out.byDay;
	}
	if (out.freq === "daily" || out.freq === "weekly") {
		delete out.byNthDay;
		delete out.byMonthDay;
		delete out.bySetPos;
	}
	if (out.freq !== "yearly") delete out.byMonth;
	if (out.freq === "yearly" && !out.byMonth) {
		delete out.byDay;
		delete out.byNthDay;
		delete out.byMonthDay;
		delete out.bySetPos;
	}
	if (out.bySetPos && !out.byDay && !out.byNthDay && !out.byMonthDay) delete out.bySetPos;
	return out;
}

/**
 * Why a rule falls outside the subset, or null when it is inside it.
 *
 * The limits are the ones that decide whether expansion here would agree with
 * the server. A yearly "second Tuesday" without a month is the second Tuesday
 * of the *year*, and a daily rule with BYDAY is a filter rather than a list;
 * both are legal iCalendar that this plugin would expand differently from
 * Apple, so they are refused rather than approximated.
 */
export function ruleProblem(rule: RecurrenceRule): string | null {
	const positional =
		Boolean(rule.byNthDay?.length) ||
		Boolean(rule.byMonthDay?.length) ||
		Boolean(rule.bySetPos?.length);
	if (rule.freq === "daily" && (rule.byDay?.length || positional)) {
		return "a daily rule cannot name days";
	}
	if (rule.freq === "weekly" && positional) return "a weekly rule cannot position its days";
	if (rule.freq !== "yearly" && rule.byMonth?.length) return "only a yearly rule names months";
	if (
		rule.freq === "yearly" &&
		!rule.byMonth?.length &&
		(positional || rule.byDay?.length)
	) {
		return "a yearly rule that picks days must name its months";
	}
	if (rule.bySetPos?.length && !rule.byDay?.length && !rule.byNthDay?.length && !rule.byMonthDay?.length) {
		return "a set position needs days to pick from";
	}
	return null;
}

/**
 * Sorts and deduplicates every list, so two rules that mean the same thing
 * serialise identically -- `sameRule` compares serialisations, and an
 * ordering difference would otherwise rewrite a series nobody touched.
 */
export function canonicalRule(rule: RecurrenceRule): RecurrenceRule {
	const out: RecurrenceRule = { freq: rule.freq, interval: rule.interval };
	if (rule.byDay?.length) {
		const seen = new Set(rule.byDay);
		out.byDay = WEEKDAYS.filter((day) => seen.has(day));
	}
	if (rule.byNthDay?.length) {
		const seen = new Map(rule.byNthDay.map((entry) => [formatDayEntry(entry), entry]));
		out.byNthDay = Array.from(seen.values()).sort(
			(a, b) => a.nth - b.nth || WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day)
		);
	}
	const numbers = (list: number[] | undefined) =>
		list?.length ? Array.from(new Set(list)).sort((a, b) => a - b) : undefined;
	const byMonth = numbers(rule.byMonth);
	if (byMonth) out.byMonth = byMonth;
	const byMonthDay = numbers(rule.byMonthDay);
	if (byMonthDay) out.byMonthDay = byMonthDay;
	const bySetPos = numbers(rule.bySetPos);
	if (bySetPos) out.bySetPos = bySetPos;
	if (rule.until) out.until = rule.until;
	else if (rule.count) out.count = rule.count;
	return out;
}

/**
 * True when a monthly or yearly rule picks its own days rather than repeating
 * the start date's day of the month.
 */
export function isPositional(rule: RecurrenceRule): boolean {
	return (
		(rule.freq === "monthly" || rule.freq === "yearly") &&
		Boolean(
			rule.byDay?.length ||
				rule.byNthDay?.length ||
				rule.byMonthDay?.length ||
				rule.bySetPos?.length ||
				rule.byMonth?.length
		)
	);
}

/** Normalises an exception list to sorted, unique YYYY-MM-DD dates. */
export function parseExceptions(value: unknown): string[] {
	const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
	const dates = new Set<string>();
	for (const entry of list) {
		const date = asDate(entry);
		if (date) dates.add(date);
	}
	return Array.from(dates).sort();
}

/** The `recurrence` value to write back to frontmatter, in a stable key order. */
export function recurrenceToFrontmatter(rule: RecurrenceRule): Record<string, unknown> {
	const out: Record<string, unknown> = { freq: rule.freq, interval: rule.interval };
	// Plain and positioned weekdays share one list, as they do in BYDAY, so a
	// note reads `byDay: [2TU]` for "the second Tuesday".
	const days = [...(rule.byDay ?? []), ...(rule.byNthDay ?? []).map(formatDayEntry)];
	if (days.length > 0) out.byDay = days;
	if (rule.byMonth?.length) out.byMonth = [...rule.byMonth];
	if (rule.byMonthDay?.length) out.byMonthDay = [...rule.byMonthDay];
	if (rule.bySetPos?.length) out.bySetPos = [...rule.bySetPos];
	if (rule.until) out.until = rule.until;
	if (rule.count) out.count = rule.count;
	return out;
}

/**
 * Expands a rule into the dates it lands on, within `[from, to]` inclusive.
 *
 * `start` is the first occurrence (the note's `date`, DTSTART's date), and is
 * always part of the series: RFC 5545 rules generate from DTSTART, so a weekly
 * BYDAY rule whose start day is not listed still begins on the start date.
 */
export function expandOccurrences(
	start: string,
	rule: RecurrenceRule | undefined,
	exceptions: string[],
	window: { from: string; to: string }
): string[] {
	const skipped = new Set(exceptions);
	if (!rule) {
		const single = start >= window.from && start <= window.to && !skipped.has(start);
		return single ? [start] : [];
	}

	const out: string[] = [];
	let generated = 0;

	const emit = (date: string): "continue" | "stop" => {
		if (date < start) return "continue";
		if (rule.until && date > rule.until) return "stop";
		generated++;
		if (rule.count && generated > rule.count) return "stop";
		// Exceptions are removed from the recurrence set after the rule has
		// generated it, so a skipped holiday does not shift the series along.
		if (!skipped.has(date) && date >= window.from && date <= window.to) out.push(date);
		if (generated >= MAX_OCCURRENCES) return "stop";
		return date > window.to ? "stop" : "continue";
	};

	// RFC 5545 leaves a DTSTART that the rule does not land on undefined, and
	// Apple resolves it by including the start anyway. Doing the same means an
	// event never disappears from its own start date.
	const withStart = (dates: string[]): string[] => {
		if (skipped.has(start) || start < window.from || start > window.to) return dates;
		return dates.includes(start) ? dates : [start, ...dates].sort();
	};

	if (rule.freq === "weekly" && rule.byDay?.length) {
		// Anchor on the Sunday of the start week: WKST only matters for rules
		// this subset does not model, so the simple anchor is safe here.
		const anchor = addDays(start, -weekdayOf(start));
		for (let week = skipTo(anchor, 7 * rule.interval, window.from, rule); ; week++) {
			const weekStart = addDays(anchor, week * 7 * rule.interval);
			let stop = false;
			for (const day of rule.byDay) {
				const date = addDays(weekStart, WEEKDAYS.indexOf(day));
				if (emit(date) === "stop") {
					stop = true;
					break;
				}
			}
			if (stop) break;
			// Guard the unbounded case: once the whole week is past the window
			// there is nothing further to find.
			if (weekStart > window.to) break;
		}
		return withStart(out);
	}

	if (isPositional(rule)) {
		const first = skipPeriods(start, rule, window.from);
		for (let step = first; step <= first + MAX_OCCURRENCES; step++) {
			const period = periodDates(start, rule, step);
			let stop = false;
			for (const date of period.dates) {
				if (emit(date) === "stop") {
					stop = true;
					break;
				}
			}
			// A period can match nothing at all (a 31st in a short month, a
			// fifth Friday), so running out of window is checked on the period
			// itself rather than left to the dates it produced.
			if (stop || period.opens > window.to) break;
		}
		return withStart(out);
	}

	const periodDays = rule.freq === "daily" ? 1 : rule.freq === "weekly" ? 7 : 0;
	const first = periodDays ? skipTo(start, periodDays * rule.interval, window.from, rule) : 0;
	for (let step = first; step <= first + MAX_OCCURRENCES; step++) {
		// A monthly rule can legitimately produce no date for a given step
		// (the 31st of February), which costs a step but is not the end.
		const date = advance(start, rule.freq, step * rule.interval);
		if (!date) continue;
		if (emit(date) === "stop") break;
	}
	return withStart(out);
}

/**
 * How many whole periods to jump before the window opens.
 *
 * A class that started two years ago would otherwise burn its whole step
 * budget reaching this month and render as nothing. Skipping is only safe
 * without COUNT, which is defined in terms of how many occurrences the rule
 * has generated so far -- so a counted series is walked from the beginning.
 */
function skipTo(start: string, periodDays: number, from: string, rule: RecurrenceRule): number {
	if (rule.count || from <= start) return 0;
	const days = (Date.parse(`${from}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
	return Math.max(0, Math.floor(days / periodDays));
}

/**
 * Whole periods a positional rule can jump before the window opens. One
 * period short of the exact figure, because the period that contains
 * `from` may begin before it. As with `skipTo`, a counted rule never skips.
 */
function skipPeriods(start: string, rule: RecurrenceRule, from: string): number {
	if (rule.count || from <= start) return 0;
	const [sy, sm] = start.split("-").map(Number);
	const [fy, fm] = from.split("-").map(Number);
	const elapsed = rule.freq === "monthly" ? (fy - sy) * 12 + (fm - sm) : fy - sy;
	return Math.max(0, Math.floor(elapsed / rule.interval) - 1);
}

/**
 * The dates a positional rule produces in its `step`th period, sorted, and
 * the first day of that period.
 *
 * The period is the month for a monthly rule and the year for a yearly one,
 * which matters for BYSETPOS: "the last" of a yearly rule over two months is
 * the last date across both, not the last of each.
 */
function periodDates(
	start: string,
	rule: RecurrenceRule,
	step: number
): { dates: string[]; opens: string } {
	const [year, month, day] = start.split("-").map(Number);
	const months: Array<{ year: number; month: number }> = [];
	if (rule.freq === "monthly") {
		const total = month - 1 + step * rule.interval;
		months.push({ year: year + Math.floor(total / 12), month: (total % 12) + 1 });
	} else {
		const target = year + step * rule.interval;
		for (const m of rule.byMonth ?? [month]) months.push({ year: target, month: m });
	}

	let dates: string[] = [];
	for (const { year: y, month: m } of months) {
		for (const d of monthDays(y, m, rule, day)) dates.push(isoDate(y, m, d));
	}
	dates.sort();

	if (rule.bySetPos?.length) {
		const picked = new Set<string>();
		for (const pos of rule.bySetPos) {
			const date = pos > 0 ? dates[pos - 1] : dates[dates.length + pos];
			if (date) picked.add(date);
		}
		dates = Array.from(picked).sort();
	}

	const first = months[0];
	const opens = isoDate(first.year, rule.freq === "yearly" ? 1 : first.month, 1);
	return { dates, opens };
}

/**
 * Days of one month a positional rule matches. Month days and weekdays are
 * intersected when both are given -- BYDAY=FR;BYMONTHDAY=13 is Friday the
 * 13th, not every Friday plus every 13th -- and with neither, the rule falls
 * on the start date's day, as a plain monthly rule would.
 */
function monthDays(year: number, month: number, rule: RecurrenceRule, fallbackDay: number): number[] {
	const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
	const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
	const weekdayOfDay = (d: number) => WEEKDAYS[(firstWeekday + d - 1) % 7];

	let byMonthDay: Set<number> | null = null;
	if (rule.byMonthDay?.length) {
		byMonthDay = new Set();
		for (const n of rule.byMonthDay) {
			const d = n > 0 ? n : length + 1 + n;
			if (d >= 1 && d <= length) byMonthDay.add(d);
		}
	}

	let byWeekday: Set<number> | null = null;
	if (rule.byDay?.length || rule.byNthDay?.length) {
		byWeekday = new Set();
		const plain = new Set(rule.byDay ?? []);
		for (let d = 1; d <= length; d++) if (plain.has(weekdayOfDay(d))) byWeekday.add(d);
		for (const { nth, day } of rule.byNthDay ?? []) {
			const target = WEEKDAYS.indexOf(day);
			let d: number;
			if (nth > 0) {
				d = 1 + ((target - firstWeekday + 7) % 7) + (nth - 1) * 7;
			} else {
				const lastWeekday = (firstWeekday + length - 1) % 7;
				d = length - ((lastWeekday - target + 7) % 7) + (nth + 1) * 7;
			}
			if (d >= 1 && d <= length) byWeekday.add(d);
		}
	}

	let days: number[];
	if (byMonthDay && byWeekday) days = [...byMonthDay].filter((d) => byWeekday!.has(d));
	else if (byMonthDay) days = [...byMonthDay];
	else if (byWeekday) days = [...byWeekday];
	else days = fallbackDay <= length ? [fallbackDay] : [];
	return days.sort((a, b) => a - b);
}

function isoDate(year: number, month: number, day: number): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Where a date sits in its month, for offering "the second Tuesday" or "the
 * last Tuesday" as a repeat for an event on that date. `isLast` is true when
 * no later same weekday exists in the month, so a fourth Tuesday can also be
 * the last one.
 */
export function positionInMonth(date: string): { nth: number; day: Weekday; isLast: boolean } {
	const [year, month, day] = date.split("-").map(Number);
	const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return {
		nth: Math.ceil(day / 7),
		day: WEEKDAYS[weekdayOf(date)],
		isLast: day + 7 > length,
	};
}

/**
 * The date `steps` periods after `start`. Returns null when a monthly or
 * yearly step lands on a day the target month does not have -- RFC 5545 skips
 * such occurrences rather than clamping them, so a rule starting on the 31st
 * simply has no February instance.
 */
function advance(start: string, freq: Frequency, steps: number): string | null {
	if (freq === "daily") return addDays(start, steps);
	// A weekly rule with no weekdays listed ("every week", as Apple writes it)
	// steps a week at a time from the start. Without this it fell through to
	// the month arithmetic below, returned the start date every time, and the
	// series drew as a single event.
	if (freq === "weekly") return addDays(start, steps * 7);

	const [year, month, day] = start.split("-").map(Number);
	const totalMonths = freq === "monthly" ? month - 1 + steps : month - 1;
	const targetYear = freq === "yearly" ? year + steps : year + Math.floor(totalMonths / 12);
	const targetMonth = ((totalMonths % 12) + 12) % 12;

	const shifted = new Date(Date.UTC(targetYear, targetMonth, day));
	if (shifted.getUTCMonth() !== targetMonth) return null;
	return shifted.toISOString().slice(0, 10);
}

const DAY_LABELS: Record<Weekday, string> = {
	SU: "Sun", MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat",
};
const MONTH_LABELS = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** 1 -> "1st", -1 -> "last", -2 -> "2nd-to-last". */
export function ordinal(n: number): string {
	if (n === -1) return "last";
	if (n < 0) return `${ordinal(-n)}-to-last`;
	const tens = n % 100;
	const suffix =
		tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
	return `${n}${suffix}`;
}

/** "weekday" for MO-FR, "weekend day" for SA/SU, else the list itself. */
function daySetLabel(days: Weekday[]): string {
	const key = days.join(",");
	if (key === "MO,TU,WE,TH,FR") return "weekday";
	if (key === "SU,SA") return "weekend day";
	if (days.length === 7) return "day";
	return days.map((day) => DAY_LABELS[day]).join("/");
}

function joinAnd(parts: string[]): string {
	if (parts.length <= 1) return parts.join("");
	return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The "on ..." phrase of a positional rule, e.g. "on the 2nd Tue". */
function positionalPhrase(rule: RecurrenceRule): string {
	const pieces: string[] = [];
	const setPos = rule.bySetPos?.length ? joinAnd(rule.bySetPos.map(ordinal)) : "";

	if (rule.byNthDay?.length) {
		pieces.push(
			joinAnd(rule.byNthDay.map(({ nth, day }) => `the ${ordinal(nth)} ${DAY_LABELS[day]}`))
		);
	}
	if (rule.byDay?.length && !rule.byMonthDay?.length) {
		pieces.push(
			setPos
				? `the ${setPos} ${daySetLabel(rule.byDay)}`
				: `every ${rule.byDay.map((day) => DAY_LABELS[day]).join(", ")}`
		);
	}
	if (rule.byMonthDay?.length) {
		const days = rule.byMonthDay.map((n) =>
			n === -1 ? "the last day" : n < 0 ? `the ${ordinal(n)} day` : `the ${ordinal(n)}`
		);
		const list = setPos ? `the ${setPos} of ${joinAnd(days)}` : joinAnd(days);
		pieces.push(
			rule.byDay?.length
				? `${list}, when it is a ${rule.byDay.map((day) => DAY_LABELS[day]).join("/")}`
				: list
		);
	}
	return pieces.length > 0 ? ` on ${pieces.join(" and ")}` : "";
}

/** Human-readable summary, e.g. "Every week on Mon, Wed until 8 Apr 2026". */
export function describeRecurrence(rule: RecurrenceRule): string {
	const noun: Record<Frequency, string> = {
		daily: "day",
		weekly: "week",
		monthly: "month",
		yearly: "year",
	};
	const every =
		rule.interval === 1 ? `Every ${noun[rule.freq]}` : `Every ${rule.interval} ${noun[rule.freq]}s`;

	let on = "";
	if (rule.freq === "weekly" && rule.byDay?.length) {
		on = ` on ${rule.byDay.map((day) => DAY_LABELS[day]).join(", ")}`;
	} else if (isPositional(rule)) {
		const months = rule.byMonth?.length
			? ` in ${rule.byMonth.map((m) => MONTH_LABELS[m - 1]).join(", ")}`
			: "";
		on = `${months}${positionalPhrase(rule)}`;
	}

	let bound = "";
	if (rule.until) bound = `, until ${rule.until}`;
	else if (rule.count) bound = `, ${rule.count} times`;

	return `${every}${on}${bound}`;
}

/**
 * How a monthly or yearly rule picks its day, in the terms the event editor
 * offers: the start date's day of the month, its weekday position ("the
 * second Tuesday"), or the last such weekday. Anything else -- a rule from
 * Apple or written by hand -- is "custom", shown but not rebuilt.
 */
export type PositionMode = "day" | "nth" | "last" | "custom";

/** The rule `mode` means for an event starting on `date`, keeping its bounds. */
export function positionRule(
	rule: RecurrenceRule,
	mode: Exclude<PositionMode, "custom">,
	date: string
): RecurrenceRule {
	const out: RecurrenceRule = { freq: rule.freq, interval: rule.interval };
	if (rule.until) out.until = rule.until;
	else if (rule.count) out.count = rule.count;
	if (mode === "day") return out;

	const position = positionInMonth(date);
	out.byNthDay = [{ nth: mode === "last" ? -1 : position.nth, day: position.day }];
	// A yearly position is within one month; without it, "the second Tuesday"
	// would be the second Tuesday of January.
	if (rule.freq === "yearly") out.byMonth = [Number(date.slice(5, 7))];
	return canonicalRule(out);
}

export function positionModeOf(rule: RecurrenceRule, date: string): PositionMode {
	if (!isPositional(rule)) return "day";
	const shape = (r: RecurrenceRule) => JSON.stringify(canonicalRule(r));
	for (const mode of ["nth", "last"] as const) {
		if (shape(rule) === shape(positionRule(rule, mode, date))) return mode;
	}
	return "custom";
}
