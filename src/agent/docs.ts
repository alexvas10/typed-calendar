import { App, TFile, TFolder, normalizePath } from "obsidian";
import { EventType } from "../model/types";

/**
 * Emits the plugin's data contract into the vault.
 *
 * No AI runs inside this plugin. Instead the file format *is* the API: any
 * agent that can read a syllabus and write a Markdown file can populate the
 * calendar, so the format is documented where an agent will actually find it.
 */

function schemaMarkdown(folder: string, types: EventType[]): string {
	const typeRows = types
		.map((type) => {
			const fields = type.fields.length
				? type.fields
						.map((field) => `\`${field.key}\` (${field.type}${field.unit ? `, ${field.unit}` : ""})`)
						.join(", ")
				: "—";
			return `| \`${type.id}\` | ${type.label} | ${fields} |`;
		})
		.join("\n");

	return `# Event schema

One Markdown note per event, stored in \`${folder}/\`. Everything the calendar
knows lives in the note's YAML frontmatter, so creating an event means creating
a file — no plugin API call is required.

## Frontmatter

\`\`\`yaml
---
uid: evt-01j8x2m4qk      # stable id; generate one if you are creating the note
title: CS 3600 Midterm   # required
types: [exam, cs3600]    # zero or more type ids; see the table below
date: 2026-10-14         # OMIT ENTIRELY if the date is unknown
startTime: "14:00"       # 24-hour; omit for an all-day event
endTime: "16:00"
allDay: false
location: MC 4021
description: Covers units 1-4
timezone: America/Toronto
status: confirmed        # confirmed | tbd
props:                   # values for the fields your types declare
  weight: 45
  course: CS 3600
recurrence:              # omit entirely for a one-off event
  freq: weekly           # daily | weekly | monthly | yearly
  interval: 1            # every N of those; 2 = every other week
  byDay: [MO, WE, FR]    # weekly: SU MO TU WE TH FR SA; monthly: 2TU, -1FR
  until: 2026-04-08      # last date the series may fall on
exceptions:              # dates the series skips, e.g. holidays
  - 2026-02-16
overrides:               # single occurrences that differ from the series
  - occurrence: 2026-03-04
    location: DC 1350
---

Body text is yours. Link to lecture notes, paste the question list, anything.
\`\`\`

## The one rule that matters

**If you do not know the date, leave \`date\` out. Do not guess, and do not
invent a placeholder.**

A syllabus that says a final exam is "TBD" should produce a note with no
\`date\` key. Such events:

- do not appear on the calendar,
- do not sync to iCloud,
- do appear in the **Expecting soon** view, which is where the user goes to
  find what still needs a date.

Setting \`status: tbd\` has the same effect and is useful when you have a
provisional date you do not trust yet.

## Repeating events

A class that meets every week is **one note**, not one note per week. Give it
the date of its first occurrence and a \`recurrence\` block; the plugin fills in
every later date, and iCloud receives it as a single repeating event.

\`\`\`yaml
date: 2026-01-05         # the FIRST occurrence; make it a day byDay lands on
startTime: "10:00"
endTime: "11:20"
recurrence:
  freq: weekly
  interval: 1
  byDay: [MO, WE, FR]
  until: 2026-04-08
\`\`\`

Rules worth knowing:

- \`date\` is the first occurrence. The series is generated from it, so it
  should be a date the rule actually lands on.
- \`until\` is **inclusive** — a series ending 8 April includes 8 April.
- Use \`count: 12\` instead of \`until\` for "twelve times". Not both.
- On a weekly rule \`byDay\` lists the meeting days. On a monthly or yearly
  rule a number in front positions the day within the month.

### Monthly and yearly rules

\`\`\`yaml
recurrence: { freq: monthly, byDay: [2TU] }              # 2nd Tuesday
recurrence: { freq: monthly, byDay: [-1FR] }             # last Friday
recurrence: { freq: monthly, byMonthDay: [1, 15] }       # the 1st and 15th
recurrence: { freq: monthly, byMonthDay: [-1] }          # last day of the month
recurrence:                                              # last weekday
  { freq: monthly, byDay: [MO, TU, WE, TH, FR], bySetPos: [-1] }
recurrence: { freq: yearly, byMonth: [11], byDay: [4TH] } # 4th Thursday of Nov
\`\`\`

- A monthly rule with none of these repeats on \`date\`'s day of the month.
- A yearly rule that picks days **must** name \`byMonth\`; without it the plugin
  drops the day parts.
- \`bySetPos\` picks the nth date (negative: from the end) out of what the
  other parts produce in one month.
- Anything fancier (BYWEEKNO, BYYEARDAY, RDATE, hourly rules) is not
  supported. If iCloud sends such a series the plugin displays it but never
  writes to it.

### Cancelling one occurrence

A holiday, a reading week, a cancelled lecture: add the date to
\`exceptions\`. **Do not** create a second note, and do not shorten \`until\`.

\`\`\`yaml
exceptions:
  - 2026-02-16   # Family Day
  - 2026-03-30   # instructor away
\`\`\`

That date disappears from the calendar and from the priority view, every other
occurrence is untouched, and the exclusion is pushed to iCloud as an EXDATE so
the phone agrees. Removing the date from the list brings the occurrence back.

### Changing one occurrence

A lecture moved to Thursday for one week, or held in another room: add an
entry to \`overrides\` on the same note. \`occurrence\` is the date the rule
puts it on — **not** where it is moving to — and every other key is optional.
Keys left out follow the series.

\`\`\`yaml
overrides:
  - occurrence: 2026-02-18   # the Wednesday lecture...
    date: 2026-02-19         # ...happens on Thursday this week
    startTime: "14:00"
    endTime: "15:20"
    location: DC 1350
  - occurrence: 2026-03-04
    title: Guest lecture     # same time and place, different title
\`\`\`

Allowed keys: \`occurrence\`, \`date\`, \`allDay\`, \`startTime\`, \`endTime\`,
\`title\`, \`location\`, \`description\`. An entry whose \`occurrence\` is not a
date the rule produces is ignored, and so is one whose date is also in
\`exceptions\` — skipping wins. Each entry is pushed to iCloud as a detached
occurrence, which is exactly what Apple Calendar makes when you edit "this
event only".

## Types

An event may carry several types and matches a filter for *any* of them, so an
exam for one course can be tagged \`[exam, cs3600]\` and found either way.

| id | label | custom fields (go under \`props\`) |
| --- | --- | --- |
${typeRows}

The live definitions, including colours and field metadata, are in
\`event-types.json\` next to this file. A machine-checkable schema for an event
note is in \`event-schema.json\`.

## Worked example: a course outline

Given a syllabus containing

> Assignment 1 — due Oct 3, 10%
> Midterm — Oct 14, 2:00–4:00pm, MC 4021, 25%
> Final exam — date TBD, 45%

write three notes:

\`\`\`yaml
# Calendar/Events/2026-10-03 CS 3600 Assignment 1.md
---
uid: evt-a1
title: CS 3600 Assignment 1
types: [assignment]
date: 2026-10-03
allDay: true
status: confirmed
props: { course: CS 3600, weight: 10 }
---
\`\`\`

\`\`\`yaml
# Calendar/Events/2026-10-14 CS 3600 Midterm.md
---
uid: evt-a2
title: CS 3600 Midterm
types: [exam]
date: 2026-10-14
startTime: "14:00"
endTime: "16:00"
allDay: false
location: MC 4021
status: confirmed
props: { course: CS 3600, weight: 25 }
---
\`\`\`

\`\`\`yaml
# Calendar/Events/CS 3600 Final Exam.md
---
uid: evt-a3
title: CS 3600 Final Exam
types: [exam]
status: tbd
props: { course: CS 3600, weight: 45 }
---
\`\`\`

Note the third has no \`date\` and no date prefix on its filename.

## Worked example: a weekly class schedule

> BUS 1220 lecture, Mon/Wed/Fri 10:00–11:20 in SSC 2050, 5 Jan to 8 Apr.
> No class on Family Day (16 Feb) or during reading week (16–20 Feb).

One note covers the whole term:

\`\`\`yaml
# Calendar/Events/BUS 1220 Lecture.md
---
uid: evt-bus1220
title: BUS 1220 Lecture
types: [class, bus1220]
date: 2026-01-05
startTime: "10:00"
endTime: "11:20"
allDay: false
location: SSC 2050
status: confirmed
props: { course: BUS 1220 }
recurrence:
  freq: weekly
  interval: 1
  byDay: [MO, WE, FR]
  until: 2026-04-08
exceptions: [2026-02-16, 2026-02-18, 2026-02-20]
---
\`\`\`

5 January 2026 is a Monday, which is why it is the start date: the first
occurrence has to be a day the rule lands on. Check that before writing the
note — a series starting on the Tuesday would generate from the wrong anchor.

## File naming

\`<YYYY-MM-DD> <Title>.md\` for dated events, \`<Title>.md\` for undated ones.
The plugin renames notes to match when it saves them, so an approximate name is
fine.

## Fields the plugin manages

\`icloud:\`, \`google:\` and \`outlook:\` hold sync bookkeeping, one per
calendar service (calendar, event id, version, modification stamps). Do not
write or edit them by hand — the plugin uses them to decide which side of a
sync won, and a hand-edited value will make it decide wrongly. A new event
needs none of them: the plugin creates it on every service it routes to.

\`{ excluded: true }\` under a service means the event was deleted there and
is deliberately kept out of it. Leave it alone unless the user asks to send
the event back, in which case remove that one key.
`;
}

function agentsMarkdown(folder: string): string {
	return `# Working with this calendar

Events are Markdown notes in \`${folder}/\`. To add, change or remove an event,
write, edit or delete the corresponding file. Nothing else is needed.

Read **EVENT_SCHEMA.md** in this folder first — it defines the frontmatter and
contains a worked syllabus example.

Points that are easy to get wrong:

1. **Unknown date means no \`date\` key.** Never invent one. The event still
   gets created; it lands in the "Expecting soon" list.
2. **\`types\` is a list.** An event can hold several and will match a filter
   for any of them.
3. **Custom values go under \`props\`**, and which keys are meaningful depends
   on the event's types. See \`event-types.json\`.
4. **A repeating event is one note.** Weekly classes get a \`recurrence\` block,
   never one note per week. To cancel a single date — a holiday — add it to
   \`exceptions\` on that same note rather than deleting or editing anything
   else. To move or change a single date, add an entry to \`overrides\`.
5. **\`readOnly: true\` means locked.** The user keeps that event as a
   record. Do not edit, move or delete it, and never remove the key.
6. **Do not touch \`icloud:\`, \`google:\` or \`outlook:\`.** They are sync
   bookkeeping, one per calendar service. In particular
   \`icloud.recurring\` without a \`recurrence\` block means iCloud repeats this
   event in a way the plugin cannot express: display it, but do not edit it.

For scripted access there is also an optional API at
\`app.plugins.plugins["typed-calendar"].api\` with \`listEvents()\`,
\`listTypes()\`, \`createEvent()\`, \`updateEvent()\`, \`skipOccurrence(uid, date)\`,
\`restoreOccurrence(uid, date)\`, \`changeOccurrence(uid, date, changes)\` and
\`resetOccurrence(uid, date)\`. Writing files is the supported path; the
API is a convenience.
`;
}

function jsonSchema(types: EventType[]): string {
	return JSON.stringify(
		{
			$schema: "https://json-schema.org/draft/2020-12/schema",
			title: "Typed Calendar event note frontmatter",
			type: "object",
			required: ["title"],
			properties: {
				uid: { type: "string" },
				title: { type: "string" },
				types: { type: "array", items: { enum: types.map((type) => type.id) } },
				date: {
					type: "string",
					pattern: "^\\d{4}-\\d{2}-\\d{2}$",
					description: "Omit entirely when the date is unknown.",
				},
				startTime: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
				endTime: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
				allDay: { type: "boolean" },
				location: { type: "string" },
				description: { type: "string" },
				timezone: { type: "string" },
				status: { enum: ["confirmed", "tbd"] },
				props: { type: "object" },
				recurrence: {
					type: "object",
					description:
						"Repeat rule. Omit for a one-off event. One note describes the " +
						"whole series; never write one note per occurrence.",
					required: ["freq"],
					properties: {
						freq: { enum: ["daily", "weekly", "monthly", "yearly"] },
						interval: { type: "integer", minimum: 1 },
						byDay: {
							type: "array",
							description:
								"Weekly: meeting days. Monthly/yearly: a leading number positions " +
								"the day in the month, e.g. 2TU (second Tuesday), -1FR (last Friday).",
							items: { type: "string", pattern: "^([+-]?[1-5])?(SU|MO|TU|WE|TH|FR|SA)$" },
						},
						byMonthDay: {
							type: "array",
							description: "Monthly/yearly: days of the month; -1 is the last day.",
							items: { type: "integer", minimum: -31, maximum: 31, not: { const: 0 } },
						},
						byMonth: {
							type: "array",
							description: "Yearly only, and required when a yearly rule picks days.",
							items: { type: "integer", minimum: 1, maximum: 12 },
						},
						bySetPos: {
							type: "array",
							description:
								"Monthly/yearly: the nth of the dates the other parts produce in a " +
								"month; negative counts from the end.",
							items: { type: "integer", minimum: -31, maximum: 31, not: { const: 0 } },
						},
						until: {
							type: "string",
							pattern: "^\\d{4}-\\d{2}-\\d{2}$",
							description: "Inclusive last date. Mutually exclusive with count.",
						},
						count: { type: "integer", minimum: 1 },
					},
					additionalProperties: false,
				},
				exceptions: {
					type: "array",
					description:
						"Dates the series skips, such as holidays. Adding a date here is " +
						"how a single occurrence is cancelled.",
					items: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
				},
				overrides: {
					type: "array",
					description:
						"Single occurrences that differ from the series. Keys left out " +
						"follow the series.",
					items: {
						type: "object",
						required: ["occurrence"],
						properties: {
							occurrence: {
								type: "string",
								pattern: "^\\d{4}-\\d{2}-\\d{2}$",
								description: "The date the rule puts this occurrence on.",
							},
							date: {
								type: "string",
								pattern: "^\\d{4}-\\d{2}-\\d{2}$",
								description: "Where it happens instead, if moved.",
							},
							allDay: { type: "boolean" },
							startTime: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
							endTime: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
							title: { type: "string" },
							location: { type: "string" },
							description: { type: "string" },
						},
						additionalProperties: false,
					},
				},
				readOnly: {
					const: true,
					description:
						"Locked by the user: never written, moved or deleted on iCloud. Do not " +
						"edit the event or remove this key.",
				},
				icloud: { type: "object", description: "Plugin-managed. Do not edit." },
				google: { type: "object", description: "Plugin-managed Google Calendar link. Do not edit." },
				outlook: { type: "object", description: "Plugin-managed Outlook link. Do not edit." },
			},
			additionalProperties: true,
		},
		null,
		2
	);
}

/**
 * Writes the docs, overwriting only files the plugin itself generated. A user
 * or agent may have edited them, but they are derived artefacts and going
 * stale is the worse failure.
 */
export async function writeAgentDocs(
	app: App,
	folder: string,
	types: EventType[]
): Promise<void> {
	// The docs are the first thing written into a fresh vault, so the folder
	// may not exist yet.
	if (folder) {
		const folderPath = normalizePath(folder);
		if (!(app.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
			try {
				await app.vault.createFolder(folderPath);
			} catch (error) {
				if (!(error instanceof Error) || !/exist/i.test(error.message)) {
					console.error("Typed Calendar: could not create event folder", error);
					return;
				}
			}
		}
	}

	const files: Record<string, string> = {
		"EVENT_SCHEMA.md": schemaMarkdown(folder || "the vault root", types),
		"AGENTS.md": agentsMarkdown(folder || "the vault root"),
		"event-schema.json": jsonSchema(types),
		"event-types.json": JSON.stringify(types, null, 2),
	};

	for (const [name, contents] of Object.entries(files)) {
		const path = normalizePath(folder ? `${folder}/${name}` : name);
		const existing = app.vault.getAbstractFileByPath(path);
		try {
			if (existing instanceof TFile) {
				await app.vault.modify(existing, contents);
			} else if (!existing) {
				await app.vault.create(path, contents);
			}
		} catch (error) {
			console.error(`Typed Calendar: could not write ${path}`, error);
		}
	}
}
