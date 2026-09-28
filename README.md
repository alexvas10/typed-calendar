# Typed Calendar

An Obsidian calendar built around **typed events**: an event can carry several
types at once, each type can declare its own custom fields, and undated events
are first-class citizens rather than errors. Dated events sync two-way with
iCloud Apple Calendar, Google Calendar and Outlook -- any or all of them.

Built because no existing plugin covers this. *Full Calendar Remastered* does
two-way iCloud sync well, but encodes categories as a title prefix
(`Category - SubCategory - Title`), which allows exactly one category per event
and no per-type fields. *iCal Pro* is one-way export. *MagicCalendar* has not
shipped in about three years and wants a raw Apple ID password.

## Views

**Calendar** — year, month, week, day and agenda views. Repeating events are
expanded into the visible range, so one note fills every week it covers.

- **+ New event** in the toolbar, or click an empty day, or drag across time
  slots in week/day view to create an event with those times filled in.
- **Types** opens the type filter. Filters are OR: selecting `exam` and
  `assignment` shows both, so you can hide a crowded class schedule and see
  only what is due. The button is outlined while a filter is hiding events.
- **Drag an event** to reschedule it; drag its bottom edge to change its end.
  Dragging one occurrence of a repeating event moves **only that occurrence**.
  Locked events cannot be dragged.
- **Hover an event** for its time, types, room and important fields.
- **Year view** shows twelve months with each event as a coloured bar; click a
  day to open that month. **Click the title** to jump to any month of any year.
- **"N awaiting dates"** appears when events have no date yet, and opens
  Expecting soon.
- The calendar reopens on the view and date you left it on.
- Keys, while the calendar is focused: `←` `→` previous/next, `T` today,
  `N` new event, `G` go to date, `Y` `M` `W` `D` `A` year, month, week, day,
  agenda.

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

**Monthly and yearly rules** can repeat on the same day of the month, or on a
weekday's position in it. In the editor, **Repeat on** offers both, worked out
from the start date: an event on 10 March 2026 can repeat "on day 10" or "on
the 2nd Tuesday". In frontmatter a number in front of a weekday positions it:

```yaml
recurrence: { freq: monthly, byDay: [2TU] }               # 2nd Tuesday
recurrence: { freq: monthly, byDay: [-1FR] }              # last Friday
recurrence: { freq: monthly, byMonthDay: [1, 15] }        # the 1st and 15th
recurrence: { freq: monthly, byDay: [MO, TU, WE, TH, FR], bySetPos: [-1] }  # last weekday
recurrence: { freq: yearly, byMonth: [11], byDay: [4TH] } # 4th Thursday of November
```

**Changing one occurrence**: a lecture moved to Thursday for one week, or held
in another room. Press **Change this occurrence** on it, or add an entry to
`overrides`. `occurrence` is the date the rule puts it on, and anything left
out follows the series, so renaming the course later still reaches it:

```yaml
overrides:
  - occurrence: 2026-02-18   # the Wednesday lecture...
    date: 2026-02-19         # ...is on Thursday this week
    startTime: "14:00"
    location: DC 1350
```

A changed occurrence is drawn with a dashed edge on the calendar and listed in
the editor under **Changed occurrences**, with **Reset to series** to undo it.
It syncs as a detached occurrence (a `RECURRENCE-ID` component), which is what
Apple Calendar creates for "this event only", and it keeps the series' alarm.

The supported rules are still a subset. They cover everything Apple
Calendar's own repeat editor produces: weekdays, intervals, positions, month
days, `until`/`count`. A series iCloud sends that falls outside them, such as
`BYWEEKNO`, `BYYEARDAY`, `RDATE`, hourly rules, or an override applying to
"this and all future events", is displayed but never written to. That
asymmetry is the point: a rule the plugin cannot write back is a rule it
cannot safely edit.

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
- **Locking an event.** Add `readOnly: true` to a note to keep it exactly as
  iCloud has it, for a finished course kept as a record, say. The plugin then
  never writes, moves or deletes its iCloud copy, while the note still follows
  the server. Remove the line to unlock it.
- **Recurring events** are two-way, within the supported subset above. A rule
  the plugin parsed is written back as a real `RRULE`, cancelled occurrences
  as `EXDATE`s, and changed occurrences as `RECURRENCE-ID` components edited
  in place, so an alarm set on one occurrence in Apple Calendar survives. A
  series an older version gave up on is read once more after upgrading, in
  case it is now writable. A series whose rule it could not parse is pulled,
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

## Google Calendar and Outlook sync

Settings → Google Calendar sync / Outlook sync. Any combination of iCloud,
Google and Outlook can be connected at once.

**How the three stay in step.** Your notes are the hub. Each service syncs
against the notes on its own, never with another service directly, so an
event pulled in from iCloud is copied to Google through its note, and an edit
made on your phone in Google reaches iCloud the same way. Each note keeps one
link per service (`icloud:`, `google:`, `outlook:`). A change usually crosses
services in one sync; occasionally, when Obsidian has not yet re-read a note
it just wrote, it takes the next one.

Everything described for iCloud applies to each service: types map to one
calendar per service (set in each type's details), routed by rank; last edit
wins with the loser backed up to `.conflicts/`; repeating events, skipped
dates and changed occurrences sync both ways; locked events are never
written; undated and TBD events stay local. Connecting a service copies every
event that routes to it, past ones included -- except locked events and
series a service cannot express. Types and custom fields are stored in each
service's private app data, which, unlike iCloud's, is not stripped.

**When something is deleted in one calendar.** Settings → Sync → *When an
event is deleted in one calendar*:

- *Remove it from that calendar only* (the default): the note and the other
  calendars keep it, and it is not sent back there. The event editor shows
  "Not in Google" with a button to send it back.
- *Delete it everywhere*: the note and every other copy are deleted too. An
  event that merely moved to another calendar on the same service is
  recognised and not deleted. Locked events are never deleted this way.

Deleting from Obsidian always removes the event from every service.

### Connecting Google (your own sign-in registration)

Google requires an app registration for calendar access. For now you create
your own; it is free and takes about five minutes.

1. Open [console.cloud.google.com](https://console.cloud.google.com), create a
   project, and in *APIs & Services → Library* enable the **Google Calendar
   API**.
2. *Google Auth Platform → Audience*: user type **External**, add your own
   Google address as a test user, then **Publish app** so it is *In
   production*. (A project left in *Testing* issues sign-ins that expire after
   seven days.) It stays unverified, which is fine for your own use: at sign-in
   Google warns about an unverified app; choose *Advanced → Go to …* to
   continue, since the app is yours.
3. *Clients → Create client*, type **Desktop app**. Copy the client ID and the
   client secret into settings. (A desktop client's secret is not a real
   secret; Google still requires it.)
4. Press **Sign in**, approve in the browser, then **Discover calendars**,
   enable the ones to sync, and check each type's Google calendar.

Google-specific: *Out of office*, *Focus time* and *Working location* entries
are left alone, since Google restricts editing them. Moves between calendars
keep the event's identity, so reminders set on the phone survive.

### Connecting Outlook (your own sign-in registration)

1. Open [entra.microsoft.com](https://entra.microsoft.com) → *App
   registrations → New registration*. Supported accounts: **Accounts in any
   organizational directory and personal Microsoft accounts**. Redirect URI:
   platform **Public client/native (mobile & desktop)**, value
   `http://localhost`.
2. *API permissions*: Microsoft Graph, delegated, **Calendars.ReadWrite** (and
   the default User.Read).
3. Copy the *Application (client) ID* into settings; Outlook needs no secret.
4. **Sign in**, **Discover calendars**, enable, map types.

Outlook-specific limits, all from Microsoft's API:

- Repeat rules must fit Outlook's patterns: one day of the month, or one
  weekday position (first to fourth, or last). "The 1st and 15th" or "the
  fifth Friday" cannot be expressed, so such an event stays out of Outlook
  rather than being flattened (the sync summary counts it as not supported).
- A deleted occurrence cannot be restored through the API. Restoring a
  skipped date in Obsidian does not bring it back in Outlook.
- There is no move between calendars; a retyped event is created in the new
  calendar and deleted from the old one, so reminders set in Outlook on that
  event do not carry over.

**Security note:** sign-in tokens sit in plaintext in `data.json` like the
iCloud password (Obsidian does not encrypt plugin data). They can be revoked
from the Google or Microsoft account's security page; *Sign out* forgets them.

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
`createEvent`, `updateEvent`, `skipOccurrence`, `changeOccurrence`,
`resetOccurrence`, `sync`) for Templater or agents that prefer
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
overrides: [ ... ]         # single occurrences that differ from the series
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
(`BYWEEKNO`, `BYYEARDAY`, `RDATE`, "this and future" edits), iCloud
Reminders (Apple does not expose them as standard CalDAV VTODO), and per-event
reminders/alarms.
