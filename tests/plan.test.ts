import assert from "node:assert/strict";
import test from "node:test";
import { planSync, mergeRemote, resourcesNeedingFetch, type SyncAction } from "../src/sync/plan";
import type { CalendarEvent } from "../src/model/types";
import type { ParsedVEvent } from "../src/sync/ics";

const CAL = "https://p01-caldav.icloud.com/123/calendars/school/";
const HREF = `${CAL}abc.ics`;

const local = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
	uid: "evt-1", title: "Midterm", types: ["exam"], date: "2026-10-14",
	startTime: "14:00", endTime: "16:00", allDay: false, status: "confirmed",
	props: { weight: 45 }, path: "a.md", ...over,
});

const bound = (over: Partial<CalendarEvent> = {}, icloud: Record<string, string> = {}) =>
	local({ ...over, icloud: { collection: CAL, href: HREF, etag: '"v1"',
		remoteModified: "2026-09-01T00:00:00Z", localModified: "2026-09-01T00:00:00Z", ...icloud } });

const remote = (over: Partial<ParsedVEvent> = {}): ParsedVEvent => ({
	uid: "evt-1", title: "Midterm", date: "2026-10-14", startTime: "14:00",
	endTime: "16:00", allDay: false, recurring: false,
	remoteModified: "2026-09-01T00:00:00Z", ...over,
});

const kinds = (actions: SyncAction[]) => actions.map((a) => a.kind);

test("only refetches resources whose ETag moved", () => {
	const events = [bound()];
	assert.deepEqual(resourcesNeedingFetch(events, [{ href: HREF, etag: '"v1"' }]), []);
	assert.deepEqual(resourcesNeedingFetch(events, [{ href: HREF, etag: '"v2"' }]), [HREF]);
});

test("an unseen remote event is adopted", () => {
	const actions = planSync({ routeFor: () => CAL, localEvents: [], calendarUrl: CAL,
		remoteResources: [{ href: HREF, etag: '"v1"' }],
		fetched: new Map([[HREF, remote({ uid: "apple-9" })]]) });
	assert.deepEqual(kinds(actions), ["create-local"]);
});

test("a never-pushed local event is created remotely", () => {
	const actions = planSync({ routeFor: () => CAL, localEvents: [local()], calendarUrl: CAL,
		remoteResources: [], fetched: new Map() });
	assert.deepEqual(kinds(actions), ["create-remote"]);
});

test("the newer remote edit wins", () => {
	const actions = planSync({ routeFor: () => CAL,
		localEvents: [bound({}, { localModified: "2026-09-10T00:00:00Z" })],
		calendarUrl: CAL,
		remoteResources: [{ href: HREF, etag: '"v2"' }],
		fetched: new Map([[HREF, remote({ remoteModified: "2026-09-20T00:00:00Z" })]]) });
	assert.deepEqual(kinds(actions), ["update-local"]);
});

test("the newer local edit wins", () => {
	const actions = planSync({ routeFor: () => CAL,
		localEvents: [bound({}, { localModified: "2026-09-25T00:00:00Z" })],
		calendarUrl: CAL,
		remoteResources: [{ href: HREF, etag: '"v2"' }],
		fetched: new Map([[HREF, remote({ remoteModified: "2026-09-20T00:00:00Z" })]]) });
	assert.deepEqual(kinds(actions), ["update-remote"]);
});

test("a local edit with an unchanged remote is pushed", () => {
	const actions = planSync({ routeFor: () => CAL,
		localEvents: [bound({}, { localModified: "2026-09-25T00:00:00Z" })],
		calendarUrl: CAL,
		remoteResources: [{ href: HREF, etag: '"v1"' }],
		fetched: new Map() });
	assert.deepEqual(kinds(actions), ["update-remote"]);
});

test("an untouched event on both sides produces no work", () => {
	const actions = planSync({ routeFor: () => CAL, localEvents: [bound()], calendarUrl: CAL,
		remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() });
	assert.deepEqual(kinds(actions), []);
});

test("an undated event is never pushed", () => {
	const actions = planSync({ routeFor: () => CAL,
		localEvents: [local({ date: undefined, icloud: undefined })],
		calendarUrl: CAL, remoteResources: [], fetched: new Map() });
	assert.deepEqual(kinds(actions), []);
});

test("an event marked TBD is withdrawn from the server", () => {
	const actions = planSync({ routeFor: () => CAL, localEvents: [bound({ status: "tbd" })], calendarUrl: CAL,
		remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() });
	assert.deepEqual(kinds(actions), ["delete-remote"]);
});

test("an event that lost its date is withdrawn from the server", () => {
	const actions = planSync({ routeFor: () => CAL, localEvents: [bound({ date: undefined })], calendarUrl: CAL,
		remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() });
	assert.deepEqual(kinds(actions), ["delete-remote"]);
});

test("a remotely deleted event unlinks rather than deleting the note", () => {
	const actions = planSync({ routeFor: () => CAL, localEvents: [bound()], calendarUrl: CAL,
		remoteResources: [], fetched: new Map() });
	assert.deepEqual(kinds(actions), ["unlink-local"]);
});

test("events bound to a different calendar are left alone", () => {
	const other = local({ icloud: { collection: "https://other/", href: "https://other/x.ics",
		etag: '"v1"', localModified: "2026-09-25T00:00:00Z" } });
	const actions = planSync({ routeFor: () => CAL, localEvents: [other], calendarUrl: CAL,
		remoteResources: [], fetched: new Map() });
	assert.deepEqual(kinds(actions), []);
});

test("merge takes remote scheduling but keeps vault-owned types and props", () => {
	const merged = mergeRemote(bound(), remote({ title: "Midterm (moved)", startTime: "16:00",
		endTime: "18:00", remoteModified: "2026-09-20T00:00:00Z" }), HREF, '"v2"', CAL);
	assert.equal(merged.title, "Midterm (moved)");
	assert.equal(merged.startTime, "16:00");
	assert.deepEqual(merged.types, ["exam"]);
	assert.deepEqual(merged.props, { weight: 45 });
	assert.equal(merged.icloud?.etag, '"v2"');
	// Local is no longer ahead of remote, so the next pass sees no local edit.
	assert.equal(merged.icloud?.localModified, merged.icloud?.remoteModified);
});

test("merge adopts types and props when the remote carries the mirror", () => {
	const merged = mergeRemote(bound(), remote({ types: ["assignment"], props: { weight: 20 } }),
		HREF, '"v2"', CAL);
	assert.deepEqual(merged.types, ["assignment"]);
	assert.deepEqual(merged.props, { weight: 20 });
});

test("a stripped X- mirror does not wipe local types", () => {
	const merged = mergeRemote(bound(), remote(), HREF, '"v2"', CAL);
	assert.deepEqual(merged.types, ["exam"]);
	assert.deepEqual(merged.props, { weight: 45 });
});

// --- calendar routing -------------------------------------------------------

test("an unbound event is not claimed by a calendar it does not route to", () => {
	const actions = planSync({ routeFor: () => "https://other/", localEvents: [local()],
		calendarUrl: CAL, remoteResources: [], fetched: new Map() });
	assert.deepEqual(kinds(actions), []);
});

test("an unbound event with no route at all is never pushed", () => {
	const actions = planSync({ routeFor: () => undefined, localEvents: [local()],
		calendarUrl: CAL, remoteResources: [], fetched: new Map() });
	assert.deepEqual(kinds(actions), []);
});

test("retyping an event moves it to the calendar its new type maps to", () => {
	const actions = planSync({ routeFor: () => "https://other/", localEvents: [bound()],
		calendarUrl: CAL, remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() });
	assert.deepEqual(kinds(actions), ["move-remote"]);
	const move = actions[0] as { from: string; to: string };
	assert.equal(move.from, CAL);
	assert.equal(move.to, "https://other/");
});

test("an event that lost its date is deleted rather than moved", () => {
	const actions = planSync({ routeFor: () => "https://other/",
		localEvents: [bound({ date: undefined })], calendarUrl: CAL,
		remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() });
	assert.deepEqual(kinds(actions), ["delete-remote"]);
});

test("a freshly pulled event produces no work on the next pass", () => {
	// Regression: SyncEngine used to leave localModified at the write time
	// rather than the remote LAST-MODIFIED, so every pulled event looked
	// locally edited and was pushed straight back. planSync is only correct
	// if the engine realigns the stamps, so pin the invariant here.
	const stamp = "2026-01-07T16:05:06.000Z";
	const pulled = local({
		types: [],
		icloud: { collection: CAL, href: HREF, etag: '"v1"',
			remoteModified: stamp, localModified: stamp },
	});
	const actions = planSync({ routeFor: () => CAL, localEvents: [pulled],
		calendarUrl: CAL, remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() });
	assert.deepEqual(kinds(actions), []);
});

test("a pulled event stamped with the sync time would be pushed back", () => {
	// The shape of the bug, kept as documentation of why the stamps matter.
	const pulled = local({
		icloud: { collection: CAL, href: HREF, etag: '"v1"',
			remoteModified: "2026-01-07T16:05:06.000Z",
			localModified: "2026-09-21T05:20:35.337Z" },
	});
	const actions = planSync({ routeFor: () => CAL, localEvents: [pulled],
		calendarUrl: CAL, remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() });
	assert.deepEqual(kinds(actions), ["update-remote"]);
});

// --- series the plugin cannot express stay pull-only ------------------------
//
// `recurring` with no `recurrence` block is the marker: the server repeats
// this event in a way we could not read back as a rule.

const recurringLocal = (icloud: Record<string, unknown> = {}) =>
	bound({}, { localModified: "2026-09-25T00:00:00Z", ...icloud } as Record<string, string>);

test("a locally edited series with no readable rule is never pushed", () => {
	const ev = recurringLocal();
	ev.icloud = { ...ev.icloud, recurring: true };
	const actions = planSync({ routeFor: () => CAL, localEvents: [ev], calendarUrl: CAL,
		remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() });
	assert.deepEqual(kinds(actions), []);
});

test("an unreadable series pulls even when local looks newer", () => {
	const ev = recurringLocal();
	ev.icloud = { ...ev.icloud, recurring: true };
	const actions = planSync({ routeFor: () => CAL, localEvents: [ev], calendarUrl: CAL,
		remoteResources: [{ href: HREF, etag: '"v2"' }],
		fetched: new Map([[HREF, remote({ recurring: true, remoteModified: "2026-01-01T00:00:00Z" })]]) });
	assert.deepEqual(kinds(actions), ["update-local"]);
});

test("an unreadable series is never moved or deleted", () => {
	const ev = bound({ status: "tbd" }); ev.icloud = { ...ev.icloud, recurring: true };
	const moved = planSync({ routeFor: () => "https://other/", localEvents: [bound()],
		calendarUrl: CAL, remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() });
	assert.deepEqual(kinds(moved), ["move-remote"]); // control: non-recurring does move
	const guarded = bound(); guarded.icloud = { ...guarded.icloud, recurring: true };
	assert.deepEqual(kinds(planSync({ routeFor: () => "https://other/", localEvents: [guarded],
		calendarUrl: CAL, remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() })), []);
	assert.deepEqual(kinds(planSync({ routeFor: () => CAL, localEvents: [ev], calendarUrl: CAL,
		remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() })), []);
});

// --- series the plugin does own are ordinary events -------------------------

const RULE = { freq: "weekly" as const, interval: 1, byDay: ["MO" as const] };

test("a series whose rule we parsed is pushed like anything else", () => {
	const ev = bound({ recurrence: { ...RULE } }, { localModified: "2026-09-25T00:00:00Z" });
	ev.icloud = { ...ev.icloud, recurring: true };
	const actions = planSync({ routeFor: () => CAL, localEvents: [ev], calendarUrl: CAL,
		remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() });
	assert.deepEqual(kinds(actions), ["update-remote"]);
});

test("cancelling one occurrence of an owned series is a push, not a delete", () => {
	const ev = bound(
		{ recurrence: { ...RULE }, exceptions: ["2026-10-19"] },
		{ localModified: "2026-09-25T00:00:00Z" }
	);
	ev.icloud = { ...ev.icloud, recurring: true };
	const actions = planSync({ routeFor: () => CAL, localEvents: [ev], calendarUrl: CAL,
		remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() });
	assert.deepEqual(kinds(actions), ["update-remote"]);
});

test("an owned series can be retyped into another calendar", () => {
	const ev = bound({ recurrence: { ...RULE } });
	ev.icloud = { ...ev.icloud, recurring: true };
	const actions = planSync({ routeFor: () => "https://other/", localEvents: [ev],
		calendarUrl: CAL, remoteResources: [{ href: HREF, etag: '"v1"' }], fetched: new Map() });
	assert.deepEqual(kinds(actions), ["move-remote"]);
});

test("a series recorded before rules were read is re-fetched exactly once", () => {
	const legacy = bound();
	legacy.icloud = { ...legacy.icloud, recurring: true };
	// ETag matches, so nothing would normally be fetched -- but the note has
	// no rule yet, so its resource must be read again to learn one.
	assert.deepEqual(resourcesNeedingFetch([legacy], [{ href: HREF, etag: '"v1"' }]), [HREF]);

	// Once the answer is known, either way, it is not asked again.
	const answered = bound({ recurrence: { ...RULE } });
	answered.icloud = { ...answered.icloud, recurring: true };
	assert.deepEqual(resourcesNeedingFetch([answered], [{ href: HREF, etag: '"v1"' }]), []);

	const unsupported = bound();
	unsupported.icloud = { ...unsupported.icloud, recurring: true, unsupportedRule: true };
	assert.deepEqual(resourcesNeedingFetch([unsupported], [{ href: HREF, etag: '"v1"' }]), []);
});

test("a pull adopts the server's rule and exclusions, and marks unreadable ones", () => {
	const owned = mergeRemote(
		bound(), remote({ recurring: true, recurrence: { ...RULE }, exceptions: ["2026-10-19"] }),
		HREF, '"v2"', CAL
	);
	assert.deepEqual(owned.recurrence, RULE);
	assert.deepEqual(owned.exceptions, ["2026-10-19"]);
	assert.equal(owned.icloud?.unsupportedRule, undefined);

	const opaque = mergeRemote(bound(), remote({ recurring: true }), HREF, '"v2"', CAL);
	assert.equal(opaque.recurrence, undefined);
	assert.equal(opaque.icloud?.unsupportedRule, true);
});

test("a series that stops repeating on the server stops repeating locally", () => {
	const merged = mergeRemote(
		bound({ recurrence: { ...RULE }, exceptions: ["2026-10-19"] }),
		remote({ recurring: false }), HREF, '"v2"', CAL
	);
	assert.equal(merged.recurrence, undefined);
	assert.equal(merged.exceptions, undefined);
});

test("a moved event is not forked into a second note by the destination's pass", () => {
	// The real failure this reproduces: an event moved from Home to Work, and
	// Work's pass -- running moments later against an index metadataCache had
	// not refreshed -- saw a resource whose uid it did not recognise locally
	// and adopted it. One event became three notes.
	const WORK = "https://p01-caldav.icloud.com/123/calendars/work/";
	const WORK_HREF = `${WORK}abc.ics`;
	// The note still claims the old collection, so it is not in Work's
	// localEvents at all.
	const stale = bound();

	const naive = planSync({
		routeFor: () => WORK, localEvents: [], calendarUrl: WORK,
		remoteResources: [{ href: WORK_HREF, etag: '"v9"' }],
		fetched: new Map([[WORK_HREF, remote()]]),
	});
	assert.deepEqual(kinds(naive), ["create-local"], "without the guard it forks");

	const guarded = planSync({
		routeFor: () => WORK, localEvents: [], calendarUrl: WORK,
		remoteResources: [{ href: WORK_HREF, etag: '"v9"' }],
		fetched: new Map([[WORK_HREF, remote()]]),
		knownUids: new Set([stale.uid]),
	});
	assert.deepEqual(guarded, [], "a uid the vault already holds is left alone");
});

test("a note whose binding this run rewrote is not unlinked behind us", () => {
	// Home's pass runs after the move and no longer lists the resource. The
	// note's stamp now points at Work, but the index has not caught up, so
	// without the guard Home would strip the binding we just wrote.
	const event = bound({}, { localModified: "2026-09-25T00:00:00Z" });
	const orphaned = { routeFor: () => CAL, localEvents: [event], calendarUrl: CAL,
		remoteResources: [], fetched: new Map() };

	assert.deepEqual(kinds(planSync(orphaned)), ["unlink-local"]);
	assert.deepEqual(planSync({ ...orphaned, claimedUids: new Set([event.uid]) }), []);
});

test("a resource genuinely deleted elsewhere still unlinks", () => {
	// The guard must not swallow the case it looks like: a uid this run never
	// touched, whose resource is gone, is still an unlink.
	const event = bound();
	const actions = planSync({ routeFor: () => CAL, localEvents: [event], calendarUrl: CAL,
		remoteResources: [], fetched: new Map(), claimedUids: new Set(["someone-else"]) });
	assert.deepEqual(kinds(actions), ["unlink-local"]);
});
