import {
	Frequency,
	NthWeekday,
	RecurrenceRule,
	Weekday,
	canonicalRule,
	formatDayEntry,
	parseDayEntry,
	ruleProblem,
} from "../model/recurrence";
import { utcToWallClock, toWallClock, wallClockToUtc } from "../util/timezone";

/**
 * RRULE <-> RecurrenceRule, as strings.
 *
 * The conversion is deliberately strict: `parseRRule` returns null for any
 * rule outside the subset the plugin can also write back. A null here is what
 * marks a series pull-only, so widening this function widens what the plugin
 * will overwrite on a real calendar -- change it with that in mind.
 */

const FREQUENCIES: Record<string, Frequency> = {
	DAILY: "daily",
	WEEKLY: "weekly",
	MONTHLY: "monthly",
	YEARLY: "yearly",
};

/** Parts we understand. Anything else present means we do not own the rule. */
const KNOWN_PARTS = new Set([
	"FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "UNTIL", "COUNT", "WKST",
]);

/**
 * A comma list of non-zero integers within +/-limit. Null when any entry is
 * out of range: a part we cannot represent exactly is a part we do not own.
 */
function integerList(value: string, limit: number, allowNegative: boolean): number[] | null {
	const out: number[] = [];
	for (const entry of value.split(",")) {
		const n = Number(entry.trim());
		if (!Number.isInteger(n) || n === 0 || Math.abs(n) > limit) return null;
		if (n < 0 && !allowNegative) return null;
		out.push(n);
	}
	return out.length > 0 ? out : null;
}

export function parseRRule(rrule: string, timezone: string): RecurrenceRule | null {
	const parts = new Map<string, string>();
	for (const chunk of rrule.split(";")) {
		const [rawKey, ...rest] = chunk.split("=");
		const key = rawKey.trim().toUpperCase();
		if (!key) continue;
		// A part we do not model changes which dates the series lands on, so
		// the honest answer is "this rule is not ours".
		if (!KNOWN_PARTS.has(key)) return null;
		parts.set(key, rest.join("=").trim());
	}

	const freq = FREQUENCIES[(parts.get("FREQ") ?? "").toUpperCase()];
	if (!freq) return null;

	const intervalRaw = parts.get("INTERVAL");
	const interval = intervalRaw ? Number(intervalRaw) : 1;
	if (!Number.isInteger(interval) || interval < 1) return null;

	const rule: RecurrenceRule = { freq, interval };

	const byDay = parts.get("BYDAY");
	if (byDay) {
		const plain: Weekday[] = [];
		const nth: NthWeekday[] = [];
		for (const entry of byDay.split(",")) {
			const parsed = parseDayEntry(entry);
			if (!parsed) return null;
			if (typeof parsed === "string") plain.push(parsed);
			else nth.push(parsed);
		}
		// A position ("2TU") only means something within a month.
		if (nth.length > 0 && freq !== "monthly" && freq !== "yearly") return null;
		if (plain.length > 0) rule.byDay = plain;
		if (nth.length > 0) rule.byNthDay = nth;
	}

	const lists: Array<[string, keyof RecurrenceRule, number, boolean]> = [
		["BYMONTHDAY", "byMonthDay", 31, true],
		["BYMONTH", "byMonth", 12, false],
		// A yearly rule over several months could in principle position past
		// the 31st. Nothing Apple's editor writes does, and refusing is the
		// safe side of that line.
		["BYSETPOS", "bySetPos", 31, true],
	];
	for (const [part, key, limit, allowNegative] of lists) {
		const value = parts.get(part);
		if (value === undefined) continue;
		const parsed = integerList(value, limit, allowNegative);
		if (!parsed) return null;
		(rule as unknown as Record<string, number[]>)[key] = parsed;
	}

	if (ruleProblem(rule)) return null;

	// WKST decides where an interval-skipped week begins, so it only changes
	// the result for a multi-week rule. Expansion anchors on Sunday.
	const wkst = (parts.get("WKST") ?? "SU").toUpperCase();
	if (freq === "weekly" && interval > 1 && wkst !== "SU") return null;

	const until = parts.get("UNTIL");
	if (until) {
		const date = untilToLocalDate(until, timezone);
		if (!date) return null;
		rule.until = date;
	}

	const count = parts.get("COUNT");
	if (count && !until) {
		const parsed = Number(count);
		if (!Number.isInteger(parsed) || parsed < 1) return null;
		rule.count = parsed;
	}

	return canonicalRule(rule);
}

/**
 * UNTIL is the last instant an occurrence may start, in UTC. The note stores a
 * local end date, so the instant is read in the event's own zone -- taking the
 * UTC date instead would move a late-evening series a day forward.
 */
function untilToLocalDate(until: string, timezone: string): string | null {
	const dateOnly = until.match(/^(\d{4})(\d{2})(\d{2})$/);
	if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;

	const stamp = until.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
	if (!stamp) return null;
	const [, y, m, d, hh, mm, ss, zulu] = stamp;
	if (!zulu) return `${y}-${m}-${d}`;
	const instant = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
	return utcToWallClock(instant, timezone).date;
}

/**
 * Serialises a rule as an RRULE value.
 *
 * UNTIL is written as the last instant of the end date in the event's zone, so
 * an occurrence on that day is still included -- an UNTIL at midnight would
 * quietly drop the final class.
 */
export function formatRRule(rule: RecurrenceRule, timezone: string, allDay: boolean): string {
	const parts = [`FREQ=${rule.freq.toUpperCase()}`];
	if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
	if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
	if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
	const days = [...(rule.byDay ?? []), ...(rule.byNthDay ?? []).map(formatDayEntry)];
	if (days.length > 0) parts.push(`BYDAY=${days.join(",")}`);
	if (rule.bySetPos?.length) parts.push(`BYSETPOS=${rule.bySetPos.join(",")}`);
	if (rule.until) parts.push(`UNTIL=${formatUntil(rule.until, timezone, allDay)}`);
	else if (rule.count) parts.push(`COUNT=${rule.count}`);
	return parts.join(";");
}

function formatUntil(until: string, timezone: string, allDay: boolean): string {
	if (allDay) return until.replace(/-/g, "");
	const wall = toWallClock(until, "23:59");
	if (!wall) return until.replace(/-/g, "");
	const instant = new Date(wallClockToUtc({ ...wall }, timezone) + 59_000);
	return instant.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Two rules are the same when they serialise identically. */
export function sameRule(
	a: RecurrenceRule | undefined,
	b: RecurrenceRule | undefined,
	timezone: string,
	allDay: boolean
): boolean {
	if (!a || !b) return !a && !b;
	return (
		formatRRule(canonicalRule(a), timezone, allDay) ===
		formatRRule(canonicalRule(b), timezone, allDay)
	);
}
