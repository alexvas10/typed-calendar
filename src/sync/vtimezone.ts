import ICAL from "ical.js";
import { timezoneAbbreviation, utcOffsetMinutes } from "../util/timezone";

/**
 * Builds a VTIMEZONE for an IANA zone, derived from Intl rather than from a
 * bundled copy of the tz database.
 *
 * This exists for one reason: a repeating event cannot be written as a UTC
 * instant. A weekly 10:00 class stored as an instant repeats every exactly 168
 * hours, so the March clock change moves it to 11:00 for the rest of the term.
 * Only a TZID-qualified DTSTART repeats against the wall clock -- and a TZID
 * without a matching VTIMEZONE is what makes servers reinterpret an hour, so
 * the two have to travel together.
 *
 * Returns null for a zone whose rules are not the ordinary "no transitions" or
 * "two transitions a year" shape. Callers fall back to floating local time,
 * which is still correct across a clock change, rather than guessing.
 */
export function buildVTimezone(timezone: string, year: number): ICAL.Component | null {
	let transitions: Transition[];
	let rulesChanged = false;
	try {
		transitions = findTransitions(timezone, year);
		// Each observance only applies from its DTSTART onward. Anchored in the
		// event's own year, the first clock change of that year would leave the
		// weeks before it undefined -- January in the northern hemisphere,
		// January to April in the southern -- and a time read back in that gap
		// comes out hours wrong. Anchoring a year earlier covers the whole year
		// when the rules are the same both years, which is nearly always.
		const earlier = findTransitions(timezone, year - 1);
		const sameRules =
			earlier.length === transitions.length &&
			earlier.every(
				(transition, i) =>
					transition.rrule === transitions[i].rrule &&
					transition.from === transitions[i].from &&
					transition.to === transitions[i].to
			);
		if (sameRules) transitions = earlier;
		else rulesChanged = true;
	} catch {
		return null;
	}
	if (transitions.length !== 0 && transitions.length !== 2) return null;

	const vtimezone = new ICAL.Component("vtimezone");
	vtimezone.updatePropertyWithValue("tzid", timezone);

	// A zone with no clock changes -- China, India, Japan, most of Africa --
	// is one offset from 1970 onward, so every date is covered.
	if (transitions.length === 0) {
		const instant = Date.UTC(year, 0, 1);
		const offset = utcOffsetMinutes(instant, timezone);
		vtimezone.addSubcomponent(
			standardComponent("standard", {
				name: timezoneAbbreviation(instant, timezone),
				from: offset,
				to: offset,
				start: { year: 1970, month: 1, day: 1, hour: 0, minute: 0 },
				rrule: null,
			})
		);
		return vtimezone;
	}

	if (rulesChanged) {
		// The rules changed this year (as in the US in 2007), so the previous
		// year's changes cannot stand in for this one's. Pin the offset in force
		// on 1 January instead, which covers the stretch before this year's
		// first change without claiming anything about earlier years.
		const instant = Date.UTC(year, 0, 1, 12);
		const offset = utcOffsetMinutes(instant, timezone);
		const lowest = Math.min(...transitions.flatMap((t) => [t.from, t.to]));
		vtimezone.addSubcomponent(
			standardComponent(offset > lowest ? "daylight" : "standard", {
				name: timezoneAbbreviation(instant, timezone),
				from: offset,
				to: offset,
				start: { year, month: 1, day: 1, hour: 0, minute: 0 },
				rrule: null,
			})
		);
	}

	for (const transition of transitions) {
		// The component is DAYLIGHT when the clocks go forward at it.
		const kind = transition.to > transition.from ? "daylight" : "standard";
		vtimezone.addSubcomponent(
			standardComponent(kind, {
				name: timezoneAbbreviation(transition.instant + 60_000, timezone),
				from: transition.from,
				to: transition.to,
				start: transition.localStart,
				rrule: transition.rrule,
			})
		);
	}
	return vtimezone;
}

interface Transition {
	instant: number;
	from: number;
	to: number;
	/** Local time the change happens, read on the pre-change clock. */
	localStart: { year: number; month: number; day: number; hour: number; minute: number };
	rrule: string;
}

function standardComponent(
	kind: "standard" | "daylight",
	spec: {
		name: string;
		from: number;
		to: number;
		start: { year: number; month: number; day: number; hour: number; minute: number };
		rrule: string | null;
	}
): ICAL.Component {
	const component = new ICAL.Component(kind);
	component.updatePropertyWithValue("tzoffsetfrom", ICAL.UtcOffset.fromSeconds(spec.from * 60));
	component.updatePropertyWithValue("tzoffsetto", ICAL.UtcOffset.fromSeconds(spec.to * 60));
	component.updatePropertyWithValue("tzname", spec.name);
	component.updatePropertyWithValue("dtstart", ICAL.Time.fromData({ ...spec.start, second: 0 }));
	if (spec.rrule) {
		component.updatePropertyWithValue("rrule", ICAL.Recur.fromString(spec.rrule));
	}
	return component;
}

const HOUR = 3_600_000;

/**
 * Finds the offset changes in a year by walking it in six-hour steps and
 * bisecting each change down to the minute. Slower than a rules table and
 * entirely free of one.
 */
function findTransitions(timezone: string, year: number): Transition[] {
	const start = Date.UTC(year, 0, 1);
	const end = Date.UTC(year + 1, 0, 1);
	const transitions: Transition[] = [];

	let previous = utcOffsetMinutes(start, timezone);
	for (let instant = start; instant < end; instant += 6 * HOUR) {
		const offset = utcOffsetMinutes(instant, timezone);
		if (offset === previous) continue;

		let low = instant - 6 * HOUR;
		let high = instant;
		while (high - low > 60_000) {
			const middle = low + Math.floor((high - low) / 2);
			if (utcOffsetMinutes(middle, timezone) === previous) low = middle;
			else high = middle;
		}

		transitions.push(describe(high, previous, offset));
		previous = offset;
	}
	return transitions;
}

function describe(instant: number, from: number, to: number): Transition {
	// The wall clock just before the change, which is what DTSTART records.
	const local = new Date(instant + from * 60_000);
	const month = local.getUTCMonth() + 1;
	const day = local.getUTCDate();
	const localStart = {
		year: local.getUTCFullYear(),
		month,
		day,
		hour: local.getUTCHours(),
		minute: local.getUTCMinutes(),
	};

	const weekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][local.getUTCDay()];
	const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), month, 0)).getUTCDate();
	// "The last Sunday in October" is a real rule in much of the world, and
	// writing it as the fourth would be wrong in five-Sunday years.
	const position = day + 7 > daysInMonth ? -1 : Math.ceil(day / 7);

	return {
		instant,
		from,
		to,
		localStart,
		rrule: `FREQ=YEARLY;BYMONTH=${month};BYDAY=${position}${weekday}`,
	};
}
