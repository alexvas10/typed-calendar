import assert from "node:assert/strict";
import test from "node:test";
import { mergeTypeFields } from "../src/settings/settings";
import type { EventType, TypeField } from "../src/model/types";

const exam = (): EventType => ({
	id: "exam",
	label: "Exam",
	color: "#c00",
	rank: 20,
	fields: [
		{ key: "course", label: "Course", type: "text", showInPriority: true },
		{ key: "weight", label: "Worth", type: "number", unit: "pts" },
	],
});

test("mergeTypeFields appends only the missing keys", () => {
	const incoming: TypeField[] = [
		{ key: "course", label: "Course", type: "text" },
		{ key: "grade", label: "Grade", type: "number", unit: "%" },
		{ key: "unit", label: "Unit", type: "text" },
	];
	const merged = mergeTypeFields(exam(), incoming);
	assert.deepEqual(
		merged.fields.map((field) => field.key),
		["course", "weight", "grade", "unit"]
	);
});

test("mergeTypeFields never changes a field the type already has", () => {
	const merged = mergeTypeFields(exam(), [{ key: "weight", label: "Weight", type: "number", unit: "%" }]);
	assert.deepEqual(merged.fields[1], { key: "weight", label: "Worth", type: "number", unit: "pts" });
});

test("mergeTypeFields returns the same object when nothing is missing", () => {
	const type = exam();
	assert.equal(mergeTypeFields(type, [{ key: "course", label: "C", type: "text" }]), type);
	assert.equal(mergeTypeFields(type, []), type);
});

test("mergeTypeFields does not mutate the type it is given", () => {
	const type = exam();
	mergeTypeFields(type, [{ key: "grade", label: "Grade", type: "number" }]);
	assert.equal(type.fields.length, 2);
});

test("mergeTypeFields skips blank keys and duplicates within the input", () => {
	const merged = mergeTypeFields(exam(), [
		{ key: " ", label: "Blank", type: "text" },
		{ key: "grade", label: "Grade", type: "number" },
		{ key: "grade", label: "Grade again", type: "text" },
	]);
	assert.deepEqual(
		merged.fields.slice(2),
		[{ key: "grade", label: "Grade", type: "number" }]
	);
});
