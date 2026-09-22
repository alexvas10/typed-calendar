/**
 * Wall-clock <-> UTC conversion for IANA timezones, using Intl rather than a
 * date library. Events are stored as a local date plus a local time plus a
 * timezone name, but CalDAV wants an unambiguous instant, so every push and
 * pull crosses this boundary.
 */

interface WallClock {
	year: number;
	month: number; // 1-12
	day: number;
	hour: number;
	minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
	let formatter = formatterCache.get(timezone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatterCache.set(timezone, formatter);
	}
	return formatter;
}

/** True when Intl accepts the name, so a typo'd zone fails loudly and early. */
export function isValidTimezone(timezone: string): boolean {
	try {
		formatterFor(timezone);
		return true;
	} catch {
		return false;
	}
}

function partsAt(instant: number, timezone: string): WallClock & { second: number } {
	const parts = formatterFor(timezone).formatToParts(new Date(instant));
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
	return {
		year: get("year"),
		month: get("month"),
		day: get("day"),
		hour: get("hour"),
		minute: get("minute"),
		second: get("second"),
	};
}

/** Offset in milliseconds that the zone is ahead of UTC at a given instant. */
function offsetAt(instant: number, timezone: string): number {
	const wall = partsAt(instant, timezone);
	const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
	return asUtc - instant;
}

/**
 * Converts a wall-clock reading in `timezone` to a UTC instant.
 *
 * The offset depends on the instant we are still solving for, so estimate with
 * the offset at the naive guess and correct once. The second pass is what
 * makes DST transitions come out right; times inside a spring-forward gap do
 * not exist and resolve to the instant just after the jump.
 */
export function wallClockToUtc(wall: WallClock, timezone: string): number {
	const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
	const firstGuess = naive - offsetAt(naive, timezone);
	const corrected = naive - offsetAt(firstGuess, timezone);
	return corrected;
}

export interface LocalDateTime {
	date: string; // YYYY-MM-DD
	time: string; // HH:mm
}

/** Renders a UTC instant as the date and time shown on a clock in `timezone`. */
export function utcToWallClock(instant: number, timezone: string): LocalDateTime {
	const wall = partsAt(instant, timezone);
	const pad = (n: number) => String(n).padStart(2, "0");
	return {
		date: `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`,
		time: `${pad(wall.hour)}:${pad(wall.minute)}`,
	};
}

/** Splits "2026-10-14" + "14:00" into the numeric parts the converter wants. */
export function toWallClock(date: string, time: string | undefined): WallClock | null {
	const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!dateMatch) return null;
	const timeMatch = (time ?? "00:00").match(/^(\d{1,2}):(\d{2})$/);
	if (!timeMatch) return null;
	return {
		year: Number(dateMatch[1]),
		month: Number(dateMatch[2]),
		day: Number(dateMatch[3]),
		hour: Number(timeMatch[1]),
		minute: Number(timeMatch[2]),
	};
}

/**
 * Minutes the zone is ahead of UTC at a given instant. Negative west of it.
 *
 * Rounded, because the comparison below resolves to whole seconds while a
 * caller bisecting for a transition will land on fractional ones -- and an
 * offset that is a few milliseconds out compares unequal to itself.
 */
export function utcOffsetMinutes(instant: number, timezone: string): number {
	return Math.round(offsetAt(instant, timezone) / 60_000);
}

/** The zone's short name at an instant, e.g. "EST". Falls back to an offset. */
export function timezoneAbbreviation(instant: number, timezone: string): string {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			timeZoneName: "short",
		}).formatToParts(new Date(instant));
		return parts.find((part) => part.type === "timeZoneName")?.value ?? timezone;
	} catch {
		return timezone;
	}
}
