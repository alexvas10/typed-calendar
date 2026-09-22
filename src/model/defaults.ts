import { EventType } from "./types";

/**
 * Seed types aimed at a student's term. These are only defaults -- the user
 * owns them from the settings tab, and agents read the live copy that gets
 * mirrored to the vault.
 */
export const DEFAULT_EVENT_TYPES: EventType[] = [
	{
		id: "exam",
		label: "Exam",
		color: "#c0392b",
		rank: 30,
		fields: [
			{ key: "course", label: "Course", type: "text", showInPriority: true },
			{ key: "weight", label: "Weight", type: "number", unit: "%", showInPriority: true },
		],
	},
	{
		id: "assignment",
		label: "Assignment",
		color: "#d98324",
		rank: 20,
		fields: [
			{ key: "course", label: "Course", type: "text", showInPriority: true },
			{ key: "weight", label: "Weight", type: "number", unit: "%", showInPriority: true },
		],
	},
	{
		id: "class",
		label: "Class",
		color: "#3d7ea6",
		rank: 5,
		fields: [
			{ key: "course", label: "Course", type: "text" },
		],
	},
	{
		id: "personal",
		label: "Personal",
		color: "#6b8e5a",
		rank: 10,
		fields: [],
	},
];
