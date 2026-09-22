# Typed Calendar

An Obsidian calendar built around **typed events**: an event can carry several
types at once, each type can declare its own custom fields, and undated events
are first-class citizens rather than errors. Dated events sync two-way with
iCloud Apple Calendar over CalDAV.

Built because no existing plugin covers this. *Full Calendar Remastered* does
two-way iCloud sync well, but encodes categories as a title prefix
(`Category - SubCategory - Title`), which allows exactly one category per event
and no per-type fields. *iCal Pro* is one-way export. *MagicCalendar* has not
shipped in about three years and wants a raw Apple ID password.

## Views

**Calendar** — month, week and agenda grids, with a filter chip per event type.
Filters are OR: selecting `exam` and `assignment` shows both, so you can hide a
crowded weekly class schedule and see only what is due. Repeating events are
expanded into the visible range, so one note fills every week it covers.

**Priority** — what is coming, soonest first, annotated with the fields each
type marked as important:

```
in 2 days   Paul's birthday          Personal
in 3 days   CS 3600 Midterm          Exam · CS 3600 · 45% · MC 4021
```

Ordering is date ascending, ties broken by type rank then by the heaviest
numeric field. It is a plain sort, not a hidden score, so a surprising order can
always be explained.

**Expecting soon** — events that exist but are not yet scheduled: a final exam
the syllabus lists as "TBD". They stay off the calendar and out of iCloud, and
show what they are still missing.

## Event types

Types are yours to define in settings. Each has a label, colour, rank, and a set
of custom fields (number, text, date, choice, checkbox) with an optional unit, a
`showInPriority` flag and a `required` flag. An exam type might declare `course`
and `weight`; those then appear as form fields in the event editor and as
annotations in the priority list.

Fields are edited under **Custom fields and rank** beneath each type in
settings: add, rename, retype, reorder the choices of a dropdown, or delete.
The `key` is what lands in an event's `props`, so renaming it does not carry
existing values across — the values stay under the old key until you move them.

## Repeating events

A class that meets every week is **one note**, not thirteen. Give the event a
repeat rule — frequency, interval, which weekdays, and a date to repeat until —
and the calendar fills in every occurrence:

```yaml
date: 2026-01-05         # the first occurrence
startTime: "10:00"
endTime: "11:20"
recurrence:
  freq: weekly           # daily | weekly | monthly | yearly
  interval: 1            # 2 would mean every other week
  byDay: [MO, WE, FR]    # weekly rules only
  until: 2026-04-08      # inclusive
exceptions:
  - 2026-02-16           # Family Day: no class
```

**Cancelling one occurrence** — a holiday, a reading week, a lecture the
instructor called off — adds that date to `exceptions`. Click the occurrence in
the calendar or the priority list and press **Skip this occurrence**; every
other date is untouched, and the skip is pushed to iCloud as an `EXDATE` so the
phone agrees. Skipped dates are listed in the editor with one click to restore.

The supported rules are deliberately a subset: frequency, interval, weekly
`BYDAY`, and either `until` or `count`. A series iCloud sends that falls outside
it — "the second Tuesday of the month", `RDATE`, or per-occurrence overrides —
is displayed but never written to. That asymmetry is the point: a rule the
plugin cannot write back is a rule it cannot safely edit.

## iCloud sync

Settings → iCloud sync. Enter your Apple ID and an **app-specific password**
from [appleid.apple.com](https://appleid.apple.com), then press **Discover
calendars** — the plugin walks the CalDAV principal and calendar-home records
itself, so there is no calendar URL to hunt for in browser devtools.

How it behaves:

- **Two-way.** Local edits are pushed; remote changes are pulled.
- **Calendars map to types.** CalDAV has no tags — a VEVENT lives in exactly
  one collection — so an iCloud calendar is effectively one category. Each
  event type can map to one calendar. Outbound, an event goes to the calendar
  of its **highest-ranked mapped type**, so `[exam, cs3600]` lands in whatever
  `exam` maps to and the course tag is ignored for routing. Inbound, an event
  pulled from a calendar gains that calendar's type, merged with any it
  already has. Types that map to nothing (course tags) never affect routing,
  and events with no mapped type go to the default calendar, or stay in the
  vault if none is set. **Discover calendars** wires this up by name
  automatically; every mapping is editable per type in settings.
- **Retyping re-homes an event.** Changing an event's highest-ranked mapped
  type moves it between iCloud calendars. CalDAV has no MOVE, so this is a
  delete from the old collection followed by a write to the new one.
- **Last edit wins**, compared per event. The losing version is copied into
  `<event folder>/.conflicts/` first, so nothing is destroyed silently.
- **Undated and `status: tbd` events never sync.** Marking a synced event TBD
  withdraws it from the server.
- **Types and custom fields are vault-owned.** They are mirrored into
  `X-TYPEDCAL-*` properties on a best-effort basis, but iCloud may strip unknown
  `X-` properties, so a pull that does not return them leaves the local values
  alone rather than clearing them. This is the one asymmetry in the sync.
- **Deleted remotely?** The link is dropped and the note is kept, not deleted.
- **Recurring events** are two-way, within the supported subset above. A rule
  the plugin parsed is written back as a real `RRULE`, and cancelled
  occurrences as `EXDATE`s. A series whose rule it could not parse is pulled,
  shown, and never written — including never moved between calendars and never
  deleted. Removing a repeat altogether is also refused: from the server it
  looks the same as a note that never knew the event repeated, so it is done by
  deleting the event and creating it again.
- **Transport:** Node's `https` module, not Obsidian's `requestUrl`.
  `requestUrl` downgrades non-standard methods to POST when a body is present,
  so PROPFIND and REPORT never reach the server (iCloud answers a POST to the
  calendar root with 400). `fetch` is blocked because iCloud sends no CORS
  headers. Node's module has neither restriction, and is available because the
  plugin is desktop-only.
- One-off times are written as UTC instants rather than TZID-qualified local
  times, since a TZID without a matching VTIMEZONE is a common source of
  servers reinterpreting the hour. The original zone stays in the note.
- **Repeating times cannot be**: a rule over instants repeats every exact 168
  hours, so a 10:00 Monday class becomes 11:00 for the rest of term at the
  March clock change. A series is therefore written against the wall clock,
  with a `VTIMEZONE` generated from `Intl` so the TZID means something. For a
  zone whose rules are not the ordinary shape, the times are left floating,
  which is still right across a clock change.

Sync runs on demand and on a timer (default every 15 minutes, 0 to disable).

**Security note:** Obsidian does not encrypt plugin settings, so the password
sits in plaintext in `.obsidian/plugins/typed-calendar/data.json`. That is why
an app-specific password is required rather than your Apple ID password — it is
scoped to this use and individually revocable.

## AI and agents

**No AI runs inside this plugin,** and it is fully usable without one. Instead
the file format is the API: every event is a Markdown note with YAML
frontmatter, so any agent that can write a file can populate the calendar, and
the index picks it up immediately.

To make agents good at it, the plugin writes four files into the event folder:

| File | Purpose |
| --- | --- |
| `EVENT_SCHEMA.md` | The frontmatter contract, with a worked syllabus example |
| `AGENTS.md` | Short operating instructions pointing at the rest |
| `event-types.json` | The live type definitions |
| `event-schema.json` | JSON Schema for validation |

Point Claude Code, Claudian, Copilot or anything else at a course outline plus
`EVENT_SCHEMA.md` and ask it to create the events. The schema is explicit that
an unknown date means **omitting** `date` rather than inventing one, which is
what routes a "TBD" final exam into Expecting soon.

There is also an optional scripted surface at
`app.plugins.plugins["typed-calendar"].api` (`listEvents`, `listTypes`,
`createEvent`, `updateEvent`, `sync`) for Templater or agents that prefer
calling code.

## Event format

```yaml
---
uid: evt-01j8x2m4qk
title: CS 3600 Midterm
types: [exam, cs3600]      # several types; filters match any of them
date: 2026-10-14           # omit entirely when unknown
startTime: "14:00"
endTime: "16:00"
allDay: false
location: MC 4021
timezone: America/Toronto
status: confirmed          # confirmed | tbd
props:
  course: CS 3600
  weight: 45
recurrence: { ... }        # repeat rule; omit for a one-off event
exceptions: [2026-02-16]   # dates the series skips
icloud: { ... }            # plugin-managed sync bookkeeping; do not hand-edit
---
```

Key names deliberately overlap Full Calendar's, so events remain readable by it
if you ever switch.

## Development

The repo lives outside the vault and is linked into it, so the vault stays free
of `node_modules` and git. In the vault's `.obsidian/plugins/typed-calendar/`,
`main.js`, `manifest.json` and `styles.css` are symlinks into this repo, while
`data.json` (which holds the iCloud credentials) stays in the vault. Reload
Obsidian after a build.


```sh
npm install
npm run dev     # watch build
npm run build   # typecheck + production bundle
npm test        # unit tests
npm run live    # live CalDAV check against the configured account
```

`npm run live` runs real discovery against iCloud using the credentials in
`data.json` and prints the calendars, resource counts and a couple of parsed
events. It is the fastest way to tell a protocol bug from a UI bug.

The test suite covers the parts that are painful to debug by hand: frontmatter
parsing, priority ordering, timezone/DST conversion, recurrence expansion and
exclusions, iCalendar round-trips, and every branch of the sync conflict rules.

## Creating event types

The calendar's filter bar ends with a **+ New type** chip. It asks for a name,
a colour and a rank, and the type is usable immediately -- it appears as a
filter chip and in the event modal's type list.

Rank decides two things: where the type sorts in the priority view, and, when
an event carries several types, which iCloud calendar it is written to. An
iCloud event lives in exactly one calendar, so that choice has to be made
somewhere, and rank makes it once rather than per event.

Custom fields and the iCloud calendar a type maps to stay in
**Settings -> Typed Calendar**. Both change how events are written to a real
account, which is not a decision to make in passing while looking at a week's
schedule.

## Status

Desktop only. Not yet implemented: recurrence beyond the subset above
(positional rules like "the last Friday", per-occurrence overrides), iCloud
Reminders (Apple does not expose them as standard CalDAV VTODO), and per-event
reminders/alarms.
