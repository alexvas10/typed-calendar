/**
 * Clock times as the event editor shows and accepts them. Stored times stay
 * "HH:mm" (24-hour) everywhere; this is only the human side.
 */

/** Minutes since midnight for "HH:mm". */
export function toMinutes(time: string): number {
	const [h, m] = time.split(":").map(Number);
	return h * 60 + m;
}

/** "HH:mm" for minutes since midnight, wrapping past midnight. */
export function fromMinutes(minutes: number): string {
	const wrapped = ((minutes % 1440) + 1440) % 1440;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

/** "20:08" -> "8:08 pm", "00:00" -> "12:00 am". */
export function formatClock(time: string): string {
	const minutes = toMinutes(time);
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	const hour12 = h % 12 === 0 ? 12 : h % 12;
	return `${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/**
 * Reads a typed time. Accepts "8", "8pm", "8:30", "830", "0830", "20:30",
 * "8.30 a.m.", "noon" and "midnight". A bare hour with no am/pm is read on
 * the 24-hour clock, so "8" is 8 am and "20" is 8 pm. Returns null for
 * anything that is not a real time, rather than guessing.
 */
export function parseClock(text: string): string | null {
	const raw = text.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
	if (raw === "noon") return "12:00";
	if (raw === "midnight") return "00:00";

	const match = raw.match(/^(\d{1,2})(?:[: ]?(\d{2}))?\s*(am|pm|a|p)?$/);
	if (!match) return null;
	let hours = Number(match[1]);
	const minutes = match[2] === undefined ? 0 : Number(match[2]);
	const meridiem = match[3]?.[0];
	if (minutes > 59) return null;

	if (meridiem) {
		if (hours < 1 || hours > 12) return null;
		if (meridiem === "a" && hours === 12) hours = 0;
		if (meridiem === "p" && hours !== 12) hours += 12;
	} else if (hours > 23) {
		return null;
	}
	return fromMinutes(hours * 60 + minutes);
}

/** How long an event runs, allowing for one that ends after midnight. */
export function durationMinutes(start: string, end: string): number {
	const span = toMinutes(end) - toMinutes(start);
	return span > 0 ? span : span + 1440;
}

/** The lengths the end-time popup offers, in minutes. */
export const PRESET_DURATIONS = [30, 60, 90, 120, 150, 180, 210, 240];

/** 30 -> "30 min", 60 -> "1 hour", 90 -> "1½ hours", 150 -> "2½ hours". */
export function formatDuration(minutes: number): string {
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (rest === 30) return `${hours}½ hours`;
	if (rest === 0) return hours === 1 ? "1 hour" : `${hours} hours`;
	return `${hours} h ${rest} min`;
}
