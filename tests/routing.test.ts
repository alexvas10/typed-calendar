import assert from "node:assert/strict";
import test from "node:test";
import { CalendarRouter, autoMapCalendars } from "../src/sync/routing";
import type { CalendarEvent, EventType } from "../src/model/types";

const ASSIGNMENTS = "https://icloud/cal/assignments/";
const EVALUATIONS = "https://icloud/cal/evaluations/";

const types: EventType[] = [
	{ id: "exam", label: "Exam", color: "#c00", rank: 30, fields: [], icloudCalendar: EVALUATIONS },
	{ id: "assignment", label: "Assignment", color: "#d80", rank: 20, fields: [], icloudCalendar: ASSIGNMENTS },
	{ id: "cs3600", label: "CS 3600", color: "#08c", rank: 1, fields: [] },
];

const ev = (t: string[]): CalendarEvent => ({
	uid: "u", title: "T", types: t, date: "2026-10-14", allDay: true,
	status: "confirmed", props: {}, path: "a.md",
});

test("routes to the highest-ranked mapped type", () => {
	const router = new CalendarRouter(types, "");
	assert.equal(router.routeFor(ev(["exam", "assignment"])), EVALUATIONS);
	assert.equal(router.routeFor(ev(["assignment"])), ASSIGNMENTS);
});

test("an unmapped course tag does not affect routing", () => {
	const router = new CalendarRouter(types, "");
	assert.equal(router.routeFor(ev(["exam", "cs3600"])), EVALUATIONS);
});

test("with no mapped type and no fallback, there is no route", () => {
	assert.equal(new CalendarRouter(types, "").routeFor(ev(["cs3600"])), undefined);
	assert.equal(new CalendarRouter(types, "").routeFor(ev([])), undefined);
});

test("the fallback catches events with no mapped type", () => {
	const router = new CalendarRouter(types, ASSIGNMENTS);
	assert.equal(router.routeFor(ev(["cs3600"])), ASSIGNMENTS);
	// A mapped type still wins over the fallback.
	assert.equal(router.routeFor(ev(["exam"])), EVALUATIONS);
});

test("a pulled event gains its calendar's type without losing others", () => {
	const router = new CalendarRouter(types, "");
	assert.deepEqual(router.withCalendarType([], EVALUATIONS), ["exam"]);
	assert.deepEqual(router.withCalendarType(["cs3600"], EVALUATIONS), ["cs3600", "exam"]);
	// Idempotent, so repeated pulls do not duplicate the tag.
	assert.deepEqual(router.withCalendarType(["exam"], EVALUATIONS), ["exam"]);
	assert.deepEqual(router.withCalendarType(["cs3600"], "https://unmapped/"), ["cs3600"]);
});

test("auto-map wires the real calendar names to sensible types", () => {
	const base: EventType[] = [
		{ id: "exam", label: "Exam", color: "#c00", rank: 30, fields: [] },
		{ id: "assignment", label: "Assignment", color: "#d80", rank: 20, fields: [] },
		{ id: "class", label: "Class", color: "#08c", rank: 5, fields: [] },
		{ id: "personal", label: "Personal", color: "#6b5", rank: 10, fields: [] },
	];
	const { types: mapped, created } = autoMapCalendars(base, [
		{ url: "u/assignments", displayName: "Assignments" },
		{ url: "u/home", displayName: "Home" },
		{ url: "u/work", displayName: "Work" },
		{ url: "u/payments", displayName: "Payments" },
		{ url: "u/evaluations", displayName: "Evaluations" },
	]);
	const find = (id: string) => mapped.find((t) => t.id === id);
	assert.equal(find("assignment")?.icloudCalendar, "u/assignments");
	assert.equal(find("exam")?.icloudCalendar, "u/evaluations");
	assert.equal(find("personal")?.icloudCalendar, "u/home");
	assert.equal(find("work")?.icloudCalendar, "u/work");
	assert.equal(find("payment")?.icloudCalendar, "u/payments");
	assert.deepEqual(created.sort(), ["Payment", "Work"]);
});

test("auto-map leaves existing mappings alone on re-discovery", () => {
	const once = autoMapCalendars(
		[{ id: "exam", label: "Exam", color: "#c00", rank: 30, fields: [], icloudCalendar: "u/manual" }],
		[{ url: "u/evaluations", displayName: "Evaluations" }]
	);
	assert.equal(once.types.find((t) => t.id === "exam")?.icloudCalendar, "u/manual");
	// The unclaimed calendar gets a type of its own rather than stealing one.
	assert.equal(once.types.find((t) => t.icloudCalendar === "u/evaluations")?.id, "evaluations");
});

test("an unrecognised calendar name becomes its own type", () => {
	const { types: mapped, created } = autoMapCalendars([], [
		{ url: "u/x", displayName: "Rowing Club" },
	]);
	assert.equal(mapped[0].id, "rowing-club");
	assert.equal(mapped[0].label, "Rowing Club");
	assert.deepEqual(created, ["Rowing Club"]);
});

test("each service routes by its own mapping, and one service's mapping never leaks into another", () => {
	const types = [
		{ id: "exam", label: "Exam", color: "#c00", rank: 30, fields: [], icloudCalendar: "icloud-evals", googleCalendar: "g-exams" },
		{ id: "personal", label: "Personal", color: "#0c0", rank: 10, fields: [], outlookCalendar: "o-home" },
	];
	const event = { uid: "u", title: "t", types: ["exam", "personal"], allDay: true, status: "confirmed" as const, props: {}, path: "" };
	assert.equal(new CalendarRouter(types, "").routeFor(event), "icloud-evals");
	assert.equal(new CalendarRouter(types, "", "googleCalendar").routeFor(event), "g-exams");
	assert.equal(new CalendarRouter(types, "", "outlookCalendar").routeFor(event), "o-home",
		"Exam outranks Personal, but Exam has no Outlook calendar, so Personal's is used");
	assert.equal(new CalendarRouter(types, "", "googleCalendar").typeForCalendar("icloud-evals"), undefined);
});

test("discovery maps a service's calendars without touching another service's mapping", () => {
	const types = [{ id: "exam", label: "Exam", color: "#c00", rank: 30, fields: [], icloudCalendar: "icloud-evals" }];
	const result = autoMapCalendars(types, [{ url: "g-exams", displayName: "Exams" }], "googleCalendar");
	const exam = result.types.find((t) => t.id === "exam")!;
	assert.equal(exam.googleCalendar, "g-exams");
	assert.equal(exam.icloudCalendar, "icloud-evals");
});
