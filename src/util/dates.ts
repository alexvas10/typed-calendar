/** Midnight today in local time -- the reference point for "in N days". */
export function startOfToday(): Date {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Renders a Date as YYYY-MM-DD in local time. */
export function toDateString(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses YYYY-MM-DD as a local date. `new Date(str)` would parse it as UTC. */
export function parseLocalDate(date: string): Date | null {
	const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return null;
	const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return isNaN(parsed.valueOf()) ? null : parsed;
}

/** Whole days from today; negative for past dates. */
export function daysUntil(date: string, from: Date = startOfToday()): number | null {
	const target = parseLocalDate(date);
	if (!target) return null;
	const ms = target.valueOf() - from.valueOf();
	return Math.round(ms / 86_400_000);
}

export function formatRelativeDays(days: number): string {
	if (days === 0) return "today";
	if (days === 1) return "tomorrow";
	if (days === -1) return "yesterday";
	if (days < 0) return `${Math.abs(days)} days ago`;
	return `in ${days} days`;
}

/** Shifts a YYYY-MM-DD date by whole days. UTC maths, so DST cannot skew it. */
export function addDays(date: string, days: number): string {
	const [y, m, d] = date.split("-").map(Number);
	const shifted = new Date(Date.UTC(y, m - 1, d + days));
	return shifted.toISOString().slice(0, 10);
}

/** Day of the week for a YYYY-MM-DD date, 0 = Sunday. */
export function weekdayOf(date: string): number {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
