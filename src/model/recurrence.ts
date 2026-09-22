import { addDays, weekdayOf } from "../util/dates";

/**
 * Repeat rules, expressed as the subset of RFC 5545 recurrence this plugin is
 * prepared to author.
 *
 * The subset is deliberate rather than lazy. A rule the plugin can parse is a
 * rule it can also write back, and writing back a rule we only half understood
 * is how a calendar loses data. Anything outside the subset -- BYSETPOS, RDATE,
 * per-occurrence overrides -- is left to the server: such a series is pulled,
 * displayed, and never written. See `isSupportedRRule`.
 */

export type Frequency = "daily" | "weekly" | "monthly" | "yearly";

/** RFC 5545 weekday codes, in week order starting Sunday. */
export const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface RecurrenceRule {
	freq: Frequency;
	/** Repeat every N periods. Always >= 1. */
	interval: number;
	/** Weekly only: which days of the week. Empty means "the start day". */
	byDay?: Weekday[];
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

function asWeekday(value: unknown): Weekday | null {
	const code = String(value ?? "").trim().toUpperCase().slice(-2);
	return (WEEKDAYS as readonly string[]).includes(code) ? (code as Weekday) : null;
}

function asDate(value: unknown): string | undefined {
	if (value instanceof Date && !isNaN(value.valueOf())) {
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
	}
	const match = String(value ?? "").trim().match(/^(\d{4})-?(\d{2})-?(\d{2})/);
	return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

/**
 * Reads a `recurrence:` block off frontmatter. Returns null for anything that
 * is not a rule we can both honour and write back, so a hand-written oddity
 * degrades to a single event rather than to a wrong series.
 */
export function parseRecurrence(value: unknown): RecurrenceRule | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;

	const freq = FREQ_BY_NAME[String(raw.freq ?? raw.frequency ?? "").trim().toLowerCase()];
	if (!freq) return null;

	const intervalRaw = Number(raw.interval ?? 1);
	const interval = Number.isFinite(intervalRaw) && intervalRaw >= 1 ? Math.floor(intervalRaw) : 1;

	const rule: RecurrenceRule = { freq, interval };

	const byDaySource = Array.isArray(raw.byDay)
		? raw.byDay
		: typeof raw.byDay === "string"
			? raw.byDay.split(",")
			: [];
	const byDay = byDaySource.map(asWeekday).filter((day): day is Weekday => day !== null);
	// BYDAY on a monthly or yearly rule means "the second Tuesday" style
	// positioning, which this subset does not model.
	if (byDay.length > 0 && freq === "weekly") rule.byDay = dedupeDays(byDay);

	const until = asDate(raw.until ?? raw.endDate);
	if (until) rule.until = until;

	const count = Number(raw.count);
	// UNTIL and COUNT are mutually exclusive in RFC 5545; a note carrying both
	// keeps the end date, which is the one a person actually reasoned about.
	if (!until && Number.isFinite(count) && count >= 1) rule.count = Math.floor(count);

	return rule;
}

function dedupeDays(days: Weekday[]): Weekday[] {
	const seen = new Set<Weekday>();
	for (const day of days) seen.add(day);
	return WEEKDAYS.filter((day) => seen.has(day));
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
	if (rule.byDay?.length) out.byDay = [...rule.byDay];
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

	const first = rule.freq === "daily" ? skipTo(start, rule.interval, window.from, rule) : 0;
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
 * The date `steps` periods after `start`. Returns null when a monthly or
 * yearly step lands on a day the target month does not have -- RFC 5545 skips
 * such occurrences rather than clamping them, so a rule starting on the 31st
 * simply has no February instance.
 */
function advance(start: string, freq: Frequency, steps: number): string | null {
	if (freq === "daily") return addDays(start, steps);

	const [year, month, day] = start.split("-").map(Number);
	const totalMonths = freq === "monthly" ? month - 1 + steps : month - 1;
	const targetYear = freq === "yearly" ? year + steps : year + Math.floor(totalMonths / 12);
	const targetMonth = ((totalMonths % 12) + 12) % 12;

	const shifted = new Date(Date.UTC(targetYear, targetMonth, day));
	if (shifted.getUTCMonth() !== targetMonth) return null;
	return shifted.toISOString().slice(0, 10);
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

	const labels: Record<Weekday, string> = {
		SU: "Sun", MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat",
	};
	const days = rule.byDay?.length
		? ` on ${rule.byDay.map((day) => labels[day]).join(", ")}`
		: "";

	let bound = "";
	if (rule.until) bound = `, until ${rule.until}`;
	else if (rule.count) bound = `, ${rule.count} times`;

	return `${every}${days}${bound}`;
}
