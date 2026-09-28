// update_calendar_event tool — edits an existing VEVENT in place and re-sends
// DKIM-signed iMIP invitations with a bumped SEQUENCE, so the attendees' clients
// treat it as an update rather than a new invite.
//
// The edit is a *partial* one: the caller passes the stable UID returned from
// create_calendar_event plus only the fields it wants to change, and every field
// it omits keeps the value we read back from CalDAV. There is no full-replacement
// mode — no caller ever has to restate what it is not changing, which is what
// used to silently drop attendees added elsewhere and collapse recurring series.
// Clearing therefore needs an explicit value: `attendees: []`, `location: ""`,
// `description: ""`, `recurrence: "none"`.
//
// Two edit scopes, chosen by `recurrenceId`:
//   - omitted → the whole event (the entire series for a recurring one);
//   - present → a single occurrence of a recurring series, written as a
//     RECURRENCE-ID override spliced alongside the untouched master (see
//     caldav/occurrence.ts). Stalwart then schedules an iMIP update scoped to
//     that instance. Omitted fields merge against that occurrence's own stored
//     state (an existing override, else the instant the recurrenceId names).
//
// Logic sits behind a `Deps` interface (discover + fetchEvent + updateEvent)
// so it unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { type ParsedAttendee, type ParsedEvent, parseEvents } from '@langmail/ical'
import { hashEmail, logger } from '@langmail/logger'

import { type AccountTimeZoneResolver, makeAccountTimeZoneResolver } from '../caldav/account-settings.ts'
import { describeReminder, MAX_REMINDER_MINUTES } from '../caldav/alarm.ts'
import {
  type CalDavConfig,
  discoverAccount,
  type FetchEventParams,
  fetchEvent,
  resolveCalendarUrl,
  type UpdateEventParams,
  updateEvent,
} from '../caldav/client.ts'
import { buildInvite, type InviteAlarm, maxSequence, parseSequence } from '../caldav/ical.ts'
import { spliceAlarms, spliceOccurrenceOverride } from '../caldav/occurrence.ts'
import {
  alignUntil,
  isSeriesOccurrence,
  recurrenceDescription,
  recurrenceSchema,
  resolveRecurrenceId,
  startContradictsRule,
  toRRule,
} from '../caldav/recurrence.ts'
import {
  allDayEndError,
  dateOnlyToInstant,
  type EventTimesResolution,
  instantToDateOnly,
  isDateOnly,
  resolveEventTimes,
  resolveInputDateTime,
  toWallClockIso,
  UTC_TIME_ZONE,
} from '../caldav/timezone.ts'
import { type CalendarObject, type DiscoveredAccount } from '../caldav/types.ts'
import { OUTWARD_DESTRUCTIVE } from './annotations.ts'
import { type AttendeeWriteThrough } from './contact-write-through.ts'
import { createCalendarEventInput, eventUidSchema } from './create-calendar-event.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

// `"none"` is the explicit "make this a one-off again" sentinel: it is the one
// clearing case with no natural empty value, and omitting `recurrence` now means
// "keep the stored rule". Listed first so it can't be read as a raw RRULE.
const NO_RECURRENCE = 'none'
const updateRecurrenceSchema = z.union([z.literal(NO_RECURRENCE), recurrenceSchema])

// Same sentinel for reminders: omitting keeps the stored alarms, a number
// replaces them all with one, `"none"` removes them.
const NO_REMINDER = 'none'

const shared = createCalendarEventInput.shape

export const updateCalendarEventInput = z.object({
  addedAttendees: z
    .array(z.email())
    .min(1)
    .max(50)
    .optional()
    .describe('Email addresses to invite on top of the stored attendees. Cannot be combined with `attendees`.'),
  attendees: shared.attendees.describe(
    'The complete attendee list after the edit; `[]` uninvites everyone. Omit to keep the stored attendees, ' +
      'or use `addedAttendees`/`removedAttendees` instead.'
  ),
  calendarUrl: shared.calendarUrl,
  description: shared.description.describe('New description; `""` clears it. Omit to keep the stored one.'),
  end: shared.end
    .optional()
    .describe(
      'New end, ISO 8601, or an exclusive date for an all-day event. Omit to keep the event’s length when ' +
        'moving `start`, its stored end otherwise.'
    ),
  location: shared.location.describe('New location; `""` clears it. Omit to keep the stored one.'),
  notify: z
    .enum(['all', 'none'])
    .optional()
    .describe('`all` (default) re-notifies the attendees by iMIP; `none` edits silently.'),
  recurrence: updateRecurrenceSchema
    .optional()
    .describe(
      `New repeat rule for the whole series; "${NO_RECURRENCE}" makes it a one-off. ` +
        `Omit to keep the stored rule. ${recurrenceDescription}`
    ),
  recurrenceId: z
    .union([z.iso.date(), z.iso.datetime({ offset: true })])
    .optional()
    .describe(
      'To change one occurrence of a repeating series alone, its original start as an ISO 8601 instant ' +
        '(e.g. 2026-06-16T10:00:00Z), or its date for an all-day series (2026-06-16). Not combinable with ' +
        '`recurrence`, `addedAttendees` or `removedAttendees`.'
    ),
  reminderMinutesBefore: z
    .union([z.literal(NO_REMINDER), z.number().int().min(0).max(MAX_REMINDER_MINUTES)])
    .optional()
    .describe(
      'Minutes before the start to remind the user (all-day events start at 00:00, so 900 = 09:00 the day ' +
        `before); replaces any stored reminders. "${NO_REMINDER}" removes them. Omit to keep the stored ones.`
    ),
  removedAttendees: z
    .array(z.email())
    .min(1)
    .max(50)
    .optional()
    .describe('Email addresses to uninvite (case-insensitive). Cannot be combined with `attendees`.'),
  start: shared.start
    .optional()
    .describe('New start, ISO 8601, or a date (2026-10-03) for an all-day event. Omit to keep the stored start.'),
  // Not `shared.timeZone`: on update this zone governs the caller's own
  // start/end and the rebuilt event's rendering, and it defaults to the stored
  // event's own zone rather than the account's.
  timeZone: shared.timeZone.describe(
    'IANA zone for the start/end you pass, e.g. Europe/Berlin: their clock digits are read as wall-clock ' +
      'time here, overriding any offset. Defaults to the event’s own stored zone. Times you omit keep theirs.'
  ),
  title: shared.title.optional().describe('New title. Omit to keep the stored one.'),
  uid: eventUidSchema,
})

export type UpdateCalendarEventArgs = z.infer<typeof updateCalendarEventInput>

// Merges an attendee delta onto the stored list: start from `base`, append
// `added`, drop everything in `removed`. All comparison is case-insensitive
// (RFC 5545 calendar-user-addresses are), and duplicates collapse to the first
// spelling seen — so re-adding an existing attendee or removing an absent one is
// a harmless no-op, and the result never carries the same address twice.
export const mergeAttendees = (base: string[], added: string[], removed: string[]): string[] => {
  const removedSet = new Set(removed.map((email) => email.toLowerCase()))
  const seen = new Set<string>()
  const result: string[] = []
  for (const email of [...base, ...added]) {
    const key = email.toLowerCase()
    if (removedSet.has(key) || seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(email)
  }
  return result
}

export interface UpdateCalendarEventDeps {
  // Upserts the effective attendees into the collected address book after a
  // successful whole-event update (never throws — see contact-write-through.ts).
  collectAttendees?: AttendeeWriteThrough
  discover: (token: string) => Promise<DiscoveredAccount>
  fetchEvent: (params: FetchEventParams) => Promise<CalendarObject | null>
  // Stored default zone (Stalwart AccountSettings.timeZone), consulted only when
  // the caller omits `timeZone` and the stored event carries no TZID of its own.
  // Shared across the calendar tools — see mcp/handler.ts.
  resolveTimeZone: AccountTimeZoneResolver
  updateEvent: (params: UpdateEventParams) => Promise<void>
}

export interface UpdateCalendarEventContext {
  args: UpdateCalendarEventArgs
  token: string
}

// Everything the single-occurrence path needs once the common preamble
// (organizer + calendar + existence checks + field resolution) has passed. The
// mutable event fields arrive already resolved (caller value or preserved
// stored value) rather than read off `args`, so this path and the whole-event
// path agree on what "the edited event" is.
interface OccurrenceUpdate {
  alarms: InviteAlarm[]
  allDay: boolean
  args: UpdateCalendarEventArgs
  attendees: string[]
  deps: UpdateCalendarEventDeps
  description?: string
  end: Date
  existing: CalendarObject
  location?: string
  // Bare organizer email — already confirmed non-null by the caller.
  organizer: string
  recurrenceId: string
  // Attendees dropped from this occurrence. Stalwart may send them a
  // cancellation regardless of `notify`, so the audit log must retain them.
  removedAttendees: string[]
  // RFC 6638 SCHEDULE-AGENT for the override's attendees; undefined = SERVER
  // (notify), 'NONE' = silent. See buildInvite.
  scheduleAgent?: 'NONE'
  start: Date
  timeZone: string
  title: string
  token: string
}

// Edits one occurrence of a recurring series: validate the target instant
// against the master's RRULE, build a RECURRENCE-ID override, and splice it into
// the stored object alongside the untouched master before PUTting it back.
const updateOccurrence = async (u: OccurrenceUpdate): Promise<ToolResult> => {
  const {
    alarms,
    allDay,
    args,
    attendees,
    deps,
    description,
    end,
    existing,
    location,
    organizer,
    recurrenceId,
    removedAttendees,
    scheduleAgent,
    start,
    timeZone,
    title,
    token,
  } = u

  // The stored object holds the master (the only VEVENT with an RRULE) plus any
  // existing overrides. The master identifies the series we validate against.
  const master = parseEvents(existing.data).find((e) => e.recurrence !== undefined)
  if (!master?.recurrence) {
    return errorResult(`Event ${args.uid} is not a recurring series; omit recurrenceId to edit it.`)
  }

  // The master RRULE is only lightly validated on create (raw rules pass
  // through to CalDAV), so `rrule` may reject one Stalwart happily stored — a
  // trailing `;`, an unknown BYDAY code, an exotic FREQ. Treat an unparseable
  // rule as a clean rejection rather than let it surface as an opaque internal
  // error: we can't confirm the instant is a real occurrence, and writing an
  // unvalidated override risks the very orphan this guard exists to prevent.
  let onOccurrence: boolean
  try {
    onOccurrence = isSeriesOccurrence(master.start, master.recurrence, recurrenceId, master.startTzid)
  } catch {
    return errorResult(
      `Could not evaluate this series' recurrence rule (${master.recurrence}) to validate ` +
        `recurrenceId ${args.recurrenceId ?? recurrenceId}. Nothing was changed.`
    )
  }
  if (!onOccurrence) {
    return errorResult(
      `recurrenceId ${args.recurrenceId ?? recurrenceId} does not match an occurrence of this series ` +
        `(${master.recurrence}); it must equal an occurrence’s original ${master.allDay ? 'date' : 'start'}. ` +
        'Nothing was changed. Use list_calendar_events to see the series.'
    )
  }
  // An EXDATE on the master cancels the instant; an override for it would be
  // an orphan the series never shows, while this tool reported success.
  if (isExcluded(master, recurrenceId)) {
    return errorResult(
      `The occurrence on ${args.recurrenceId ?? recurrenceId} was cancelled, so there is nothing to edit. ` +
        'Nothing was changed.'
    )
  }

  // Bump past every SEQUENCE already in the object so this override supersedes
  // any prior edit of the same instance.
  const sequence = maxSequence(existing.data) + 1
  const override = buildInvite({
    alarms,
    allDay,
    attendees,
    end,
    // The master's stored ORGANIZER wins over the discovered principal: an
    // event created under a previous account address (still an alias) would
    // otherwise get an override with a different ORGANIZER, which Stalwart
    // rejects with 412 SameOrganizerInAllComponents (see
    // docs/reference/stalwart/observed-behaviour.md).
    organizer: master.organizer ?? organizer,
    recurrenceAllDay: master.allDay === true,
    recurrenceTimeZone: master.startTzid ?? UTC_TIME_ZONE,
    recurrenceId: new Date(recurrenceId),
    sequence,
    start,
    timeZone,
    title,
    uid: args.uid,
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    ...(scheduleAgent ? { scheduleAgent } : {}),
  })
  const ical = spliceOccurrenceOverride(existing.data, override, recurrenceId)

  await deps.updateEvent({ ical, token, url: existing.url, ...(existing.etag ? { etag: existing.etag } : {}) })
  logSchedulingHandover({
    attendees,
    ical,
    recurrenceId,
    removedAttendees,
    scheduleAgent,
    sequence,
    uid: args.uid,
  })

  // An occurrence edit is a scheduling action like any other, so its
  // attendees are collected too.
  await deps.collectAttendees?.({
    attendees: attendeesWithStoredNames(attendees, master),
    organizer: master.organizer ?? organizer,
    selfAddress: organizer,
    start: start.toISOString(),
    token,
    uid: args.uid,
  })

  return textResult(
    `Occurrence of "${title}" on ${args.recurrenceId ?? recurrenceId} updated ` +
      `(${deliverySummary(attendees, scheduleAgent, removedAttendees.length > 0)}${reminderSummary(args, allDay)}). ` +
      'The rest of the series is unchanged.'
  )
}

// The reminder change an edit made, for the result line; empty when the
// stored reminders were kept.
const reminderSummary = (args: UpdateCalendarEventArgs, allDay: boolean): string => {
  if (args.reminderMinutesBefore === undefined) {
    return ''
  }
  return args.reminderMinutesBefore === NO_REMINDER
    ? '; reminders removed'
    : `; reminder ${describeReminder(args.reminderMinutesBefore, allDay)}`
}

// Audit line for the accepted PUT: the iMIP fan-out it triggers is otherwise
// unobservable (Stalwart archives nothing outbound), so record enough to answer
// "was a message due, to whom, at which revision" after the fact. Emitted only
// after the PUT succeeds — a rejected PUT hands nothing to Stalwart and must
// not leave an audit line claiming otherwise. Attendee addresses are logged as
// hashes (REVIEW.md: no email addresses in logs).
const logSchedulingHandover = (handover: {
  attendees: string[]
  ical: string
  recurrenceId?: string
  removedAttendees: string[]
  // Deliberately non-optional (undefined = SERVER) so call sites pass their
  // possibly-undefined value straight through instead of conditional-spreading.
  scheduleAgent: 'NONE' | undefined
  sequence: number
  uid: string
}): void => {
  logger.info(
    {
      attendeeHashes: handover.attendees.map(hashEmail),
      bytes: Buffer.byteLength(handover.ical),
      removedAttendeeHashes: handover.removedAttendees.map(hashEmail),
      scheduleAgent: handover.scheduleAgent ?? 'SERVER',
      sequence: handover.sequence,
      // Calendar UIDs are commonly email-shaped, so they need the same
      // log-safe deterministic hashing as addresses.
      uidHash: hashEmail(handover.uid),
      ...(handover.recurrenceId ? { recurrenceId: handover.recurrenceId } : {}),
    },
    'event PUT to CalDAV; iMIP fan-out delegated to Stalwart'
  )
}

// One-line human summary of who the PUT notified. Dropping an attendee is
// Stalwart's RFC 6638 cue to CANCEL them, and SCHEDULE-AGENT=NONE is only
// stamped on the attendees that *remain* — so neither the zero-attendee branch
// nor a silent edit that removed someone may claim nobody heard anything.
// True when the edit drops anyone the stored event had — whether they were
// named in `removedAttendees` or simply left out of a replacement `attendees`
// list. Compared case-insensitively, like every other address comparison here.
const removedAttendees = (stored: string[], resolved: string[]): string[] => {
  const kept = new Set(resolved.map((email) => email.toLowerCase()))
  return stored.filter((email) => !kept.has(email.toLowerCase()))
}

// Reports what was handed to Stalwart, not what it sent — the iMIP fan-out is
// Stalwart's (RFC 6638), so this names the intended recipients, not delivery
// receipts. Until 0.16.21 the moved-occurrence path was additionally
// unreliable (an RFC-invalid METHOD:ADD Google could not load); that is fixed
// upstream and guarded by caldav/stalwart-move-occurrence.test.ts.
const deliverySummary = (attendees: string[], scheduleAgent?: 'NONE', removedAny = false): string => {
  if (attendees.length === 0) {
    return 'no attendees remain; anyone previously invited may receive a cancellation'
  }
  if (scheduleAgent === 'NONE') {
    return removedAny
      ? 'no notifications sent to the remaining attendees; a removed attendee may still receive a cancellation'
      : 'no notifications sent'
  }
  return `notifications sent to ${attendees.length} attendee(s): ${attendees.join(', ')}`
}

// The stored state an omitted field falls back to. On the whole-event path this
// is the master VEVENT; on the single-occurrence path it is the occurrence's own
// state, so editing an already-customized occurrence never reverts it to the
// master's title/time.
interface EditBase {
  // The stored VALARMs as raw content lines, carried into the rebuilt VEVENT
  // verbatim unless the caller replaces them (see resolveAlarms).
  alarms: string[][]
  // True when the stored DTSTART is a DATE: `start`/`end` are then date-only
  // strings and `end` is exclusive.
  allDay: boolean
  attendees: string[]
  description?: string
  // ISO wall-clock (or `…Z`) strings exactly as stored, not yet resolved against
  // a timezone — resolveEditFields does that once, for caller and stored values
  // alike.
  end?: string
  // True when the stored VEVENT excludes instants (EXDATE) — cancelled
  // occurrences a rebuild would resurrect. See mergeSafetyError.
  hasExcludedDates: boolean
  location?: string
  recurrence?: string
  start?: string
  // The zone `start`/`end` are wall-clock in (the stored DTSTART's TZID).
  // Distinct from the caller's `timeZone`: a preserved value must be read in the
  // zone it was *stored* in, while the caller's own values — and the rendering
  // of the rebuilt VEVENT — follow `timeZone`. Absent for the UTC (`…Z`) form.
  timeZone?: string
  title?: string
  // > 0 when some stored ATTENDEE couldn't be reduced to an email; preserving
  // the attendee list would then drop those people. See mergeSafetyError.
  unparsedAttendeeCount: number
}

const baseOf = (event: ParsedEvent | undefined): EditBase => ({
  alarms: (event?.alarms ?? []).map((a) => a.lines),
  allDay: event?.allDay === true,
  attendees: (event?.attendees ?? []).map((a) => a.email),
  hasExcludedDates: (event?.excludedDates?.length ?? 0) > 0,
  unparsedAttendeeCount: event?.unparsedAttendeeCount ?? 0,
  ...(event?.description ? { description: event.description } : {}),
  ...(event?.end ? { end: event.end } : {}),
  ...(event?.location ? { location: event.location } : {}),
  ...(event?.recurrence ? { recurrence: event.recurrence } : {}),
  ...(event?.start ? { start: event.start } : {}),
  ...(event?.startTzid ? { timeZone: event.startTzid } : {}),
  ...(event?.title ? { title: event.title } : {}),
})

// The event fields an edit resolves to, once the caller's values and the
// preserved stored values have been reconciled.
interface ResolvedFields {
  alarms: InviteAlarm[]
  allDay: boolean
  attendees: string[]
  description?: string
  end: Date
  location?: string
  scheduleAgent?: 'NONE'
  start: Date
  title: string
}

type FieldResolution = { error: string; ok: false } | { ok: true; value: ResolvedFields }

// The fields that actually change the event. A call naming none of them (just a
// `uid`, or a `recurrenceId` that scopes nothing) has nothing to write.
const MUTATING_FIELDS = [
  'addedAttendees',
  'attendees',
  'description',
  'end',
  'location',
  'recurrence',
  'reminderMinutesBefore',
  'removedAttendees',
  'start',
  'title',
] as const satisfies readonly (keyof UpdateCalendarEventArgs)[]

// Rejects contradictory or empty field combinations up front (validated here,
// not in the schema, so registerTool can keep the plain-object `.shape`).
// Returns the error message, or undefined when the combination is coherent.
const combinationError = (args: UpdateCalendarEventArgs, isDelta: boolean): string | undefined => {
  if (MUTATING_FIELDS.every((field) => args[field] === undefined)) {
    return 'Nothing to update: pass at least one field to change — `start`/`end` to reschedule, `title`, `location`, `description`, `attendees` (or `addedAttendees`/`removedAttendees`), `recurrence`, or `reminderMinutesBefore`.'
  }
  // `recurrence` re-rules the whole series; `recurrenceId` edits one occurrence.
  if (args.recurrenceId !== undefined && args.recurrence !== undefined) {
    return 'Pass either `recurrence` (to re-rule the whole series) or `recurrenceId` (to edit a single occurrence), not both.'
  }
  // A delta and a replacement of the attendee list are contradictory.
  if (isDelta && args.attendees !== undefined) {
    return 'Pass either `attendees` (the complete replacement list) or `addedAttendees`/`removedAttendees` (a delta against the stored list), not both.'
  }
  // Attendee membership is a property of the whole series; a single-occurrence
  // scope would make it ambiguous whose list is being edited.
  if (isDelta && args.recurrenceId !== undefined) {
    return 'Attendee changes (`addedAttendees`/`removedAttendees`) apply to the whole event and cannot be combined with `recurrenceId`. Omit `recurrenceId` to change the series’ attendees.'
  }
  return
}

// True when an ISO string carries an explicit clock time (…THH:MM:SS…), as
// opposed to a date-only value (all-day event) or an empty string (an event
// stored with DURATION and no DTEND).
const CLOCK_TIME_RE = /T\d{2}:\d{2}:\d{2}/u
const hasClockTime = (iso: string | undefined): boolean => iso !== undefined && CLOCK_TIME_RE.test(iso)
// A stored start/end an edit can carry over: a clock time, or an all-day date.
const isReadableTime = (iso: string | undefined): boolean => hasClockTime(iso) || isDateOnly(iso)

// A caller that re-specifies the event's whole shape — its time, title, attendee
// list and repeat rule — has said what the event should become without relying
// on anything stored. That is the one edit allowed to flatten per-occurrence
// customizations, because nothing is being silently carried over.
const isWholeEventRespecification = (args: UpdateCalendarEventArgs): boolean =>
  args.start !== undefined &&
  args.end !== undefined &&
  args.title !== undefined &&
  args.attendees !== undefined &&
  args.recurrence !== undefined

// A partial edit rebuilds the event from its stored state, so refuse — with a
// clear, actionable error — when that stored state can't be reproduced
// faithfully, rather than silently dropping data. Each check fires only when the
// edit actually preserves the field it protects.
const mergeSafetyError = (stored: ParsedEvent[], base: EditBase, args: UpdateCalendarEventArgs): string | undefined => {
  // Per-occurrence overrides (master + RECURRENCE-ID VEVENTs share the object):
  // a whole-event rebuild collapses the object to a single VEVENT and discards
  // them. The occurrence path splices instead of rebuilding, so it is exempt.
  if (args.recurrenceId === undefined && stored.length > 1 && !isWholeEventRespecification(args)) {
    return 'This event has individually-customized occurrences; editing the whole event would discard them. Edit the occurrence(s) directly (with `recurrenceId`), or re-specify the whole event (`start`, `end`, `title`, `attendees` and `recurrence`) to replace the series.'
  }
  // delete_calendar_event cancels one occurrence by writing an EXDATE onto the
  // master, not by adding a VEVENT — so `stored.length` stays 1 and the guard
  // above can't see it. A rebuilt VEVENT carries no EXDATE, which would
  // resurrect the cancelled instance and re-invite everyone to it.
  if (args.recurrenceId === undefined && base.hasExcludedDates) {
    return 'This series has cancelled occurrence(s); editing the whole event would restore them and re-invite the attendees. Edit an occurrence directly (with `recurrenceId`), or delete the event and recreate it.'
  }
  // A non-mailto attendee (e.g. an Apple `urn:uuid:` cal-address) the parser
  // can't reduce to an email — keeping the stored list would drop them.
  if (args.attendees === undefined && base.unparsedAttendeeCount > 0) {
    return 'This event has attendee(s) in an address format the connector can’t safely preserve. Pass the complete `attendees` list instead.'
  }
  // A preserved start has to be a clock time or an all-day date.
  if (args.start === undefined && !isReadableTime(base.start)) {
    return 'This event has no explicit start time; pass `start` and `end` to edit it.'
  }
  // A preserved end is the stored end, or — when `start` moves — the stored
  // duration carried over; either way both stored values have to be readable.
  // An event stored with DURATION and no DTEND has no end to read.
  if (args.end === undefined && !(isReadableTime(base.start) && isReadableTime(base.end))) {
    return 'This event has no explicit end time (e.g. one stored with a DURATION); pass `start` and `end` to edit it.'
  }
  return
}

// The effective attendee list: a delta merges add/remove onto the stored
// attendees (read from Langmail, not re-supplied), an explicit `attendees`
// replaces them wholesale, and omitting both keeps them as stored.
const resolveAttendees = (
  args: UpdateCalendarEventArgs,
  isDelta: boolean,
  base: EditBase
): { attendees: string[] } | { error: string } => {
  if (isDelta) {
    const attendees = mergeAttendees(base.attendees, args.addedAttendees ?? [], args.removedAttendees ?? [])
    // A delta that empties the list is likelier a mistake than an intent; the
    // explicit way to strip every attendee is `attendees: []`.
    if (attendees.length === 0) {
      return {
        error:
          'Removing those attendees would leave the event with none. To keep the event without attendees, pass `attendees: []`; otherwise delete the event or keep at least one attendee.',
      }
    }
    return { attendees }
  }
  return { attendees: args.attendees ?? base.attendees }
}

// Reconciles every editable field: the caller's value wins, and an omitted field
// keeps the stored one. `location`/`description` accept `""` to clear (an empty
// string is falsy, so it simply drops the property from the rebuilt VEVENT).
const resolveEditFields = (
  args: UpdateCalendarEventArgs,
  isDelta: boolean,
  base: EditBase,
  timeZone: string
): FieldResolution => {
  const attendees = resolveAttendees(args, isDelta, base)
  if ('error' in attendees) {
    return { error: attendees.error, ok: false }
  }

  const title = args.title ?? base.title
  if (title === undefined) {
    return { error: 'This event has no readable title to keep; pass `title`.', ok: false }
  }
  const times = resolveEditTimes(args, base, timeZone)
  if (!times.ok) {
    return times
  }
  const { allDay, end, start } = times.value

  const location = args.location ?? base.location
  const description = args.description ?? base.description
  return {
    ok: true,
    value: {
      alarms: resolveAlarms(args, base),
      allDay,
      attendees: attendees.attendees,
      end,
      start,
      title,
      ...(description ? { description } : {}),
      ...(location ? { location } : {}),
      ...(args.notify === 'none' ? { scheduleAgent: 'NONE' as const } : {}),
    },
  }
}

// The alarms the edited VEVENT carries: a number replaces every stored alarm
// with one DISPLAY reminder, `"none"` drops them all, and omitting it carries
// the stored ones across verbatim.
const resolveAlarms = (args: UpdateCalendarEventArgs, base: EditBase): InviteAlarm[] => {
  if (args.reminderMinutesBefore === NO_REMINDER) {
    return []
  }
  if (args.reminderMinutesBefore !== undefined) {
    return [{ minutesBefore: args.reminderMinutesBefore }]
  }
  return base.alarms.map((lines) => ({ lines }))
}

// Whether the edited event is all-day: the value type of whichever time the
// caller passed (start first), else the stored event's.
const targetAllDay = (args: UpdateCalendarEventArgs, base: EditBase): boolean => {
  const given = args.start ?? args.end
  return given === undefined ? base.allDay : isDateOnly(given)
}

// Resolves the edited event's times. Passing both `start` and `end` states them
// outright (and may switch between all-day and timed); passing one or neither
// carries the rest over from storage, which only makes sense within the stored
// kind — converting with one side would have to invent the other side's clock
// time or length.
const resolveEditTimes = (args: UpdateCalendarEventArgs, base: EditBase, timeZone: string): EventTimesResolution => {
  const allDay = targetAllDay(args, base)
  if (args.start !== undefined && args.end !== undefined) {
    return resolveEventTimes(args.start, args.end, timeZone, args.timeZone !== undefined)
  }
  if (allDay !== base.allDay) {
    return {
      error:
        'To switch an event between all-day and timed, pass both `start` and `end` — dates (YYYY-MM-DD, end ' +
        'exclusive) for all-day, date-times for timed.',
      ok: false,
    }
  }
  if (args.start === undefined && base.start === undefined) {
    return { error: 'This event has no readable start to keep; pass `start` and `end`.', ok: false }
  }
  // A caller-supplied value is read with the caller's timeZone semantics; a
  // preserved stored value is read as wall-clock in the zone it was *stored* in
  // (base.timeZone), never in the caller's — an explicit `timeZone` on a
  // title-only edit must not silently re-express the event elsewhere.
  const start =
    args.start === undefined
      ? resolveStored(base.start ?? '', base, timeZone)
      : resolveCallerTime(args.start, args, timeZone)
  const end = resolveEnd(args, base, timeZone, start)
  if (end === undefined) {
    return { error: 'This event has no readable end to keep; pass `start` and `end`.', ok: false }
  }
  if (end <= start) {
    return {
      error: allDay ? allDayEndError(instantToDateOnly(start)) : 'Event end must be after its start.',
      ok: false,
    }
  }
  return { ok: true, value: { allDay, end, start } }
}

// A caller's start/end: an all-day date as its UTC midnight, a date-time read
// with the caller's timeZone semantics.
const resolveCallerTime = (value: string, args: UpdateCalendarEventArgs, timeZone: string): Date =>
  isDateOnly(value) ? dateOnlyToInstant(value) : resolveInputDateTime(value, timeZone, args.timeZone !== undefined)

// The effective end. An explicit `end` wins. Omitting it while moving `start`
// keeps the event's stored *duration* — "push the standup an hour later" is a
// one-field call and must not silently stretch the meeting — and omitting it
// without moving `start` keeps the stored end.
// A stored wall-clock value, read in the zone it was stored in. `timeZone` is
// only the fallback for a floating stored time (no TZID, no `Z`), where the
// caller's zone is the best guess we have.
const resolveStored = (iso: string, base: EditBase, timeZone: string): Date =>
  isDateOnly(iso) ? dateOnlyToInstant(iso) : resolveInputDateTime(iso, base.timeZone ?? timeZone, false)

const resolveEnd = (args: UpdateCalendarEventArgs, base: EditBase, timeZone: string, start: Date): Date | undefined => {
  if (args.end !== undefined) {
    return resolveCallerTime(args.end, args, timeZone)
  }
  if (base.start === undefined || base.end === undefined) {
    return
  }
  const storedStart = resolveStored(base.start, base, timeZone)
  const storedEnd = resolveStored(base.end, base, timeZone)
  if (args.start === undefined) {
    return storedEnd
  }
  return new Date(start.getTime() + (storedEnd.getTime() - storedStart.getTime()))
}

// The whole-series RRULE for a whole-event edit: an explicit `recurrence`
// re-rules the series, the `"none"` sentinel collapses it to a one-off, and
// omitting it keeps the stored rule.
// Every rule is re-aligned to the edited event (alignUntil), so a preserved rule
// follows the event across a switch between all-day and timed.
const resolveRrule = (
  args: UpdateCalendarEventArgs,
  base: EditBase,
  allDay: boolean,
  timeZone: string
): string | undefined => {
  if (args.recurrence === NO_RECURRENCE) {
    return
  }
  const rrule = args.recurrence === undefined ? base.recurrence : toRRule(args.recurrence)
  return rrule === undefined ? undefined : alignUntil(rrule, allDay, timeZone)
}

// Names for the effective attendees of the contact write-through, recovered
// from the stored parse where available (a CN survives the rebuild; a
// freshly added address has none).
const attendeesWithStoredNames = (attendees: string[], storedMaster: ParsedEvent | undefined): ParsedAttendee[] => {
  const names = new Map((storedMaster?.attendees ?? []).map((a) => [a.email.toLowerCase(), a.name]))
  return attendees.map((email) => {
    const name = names.get(email.toLowerCase())
    return { email, ...(name ? { name } : {}) }
  })
}

// Moving a series onto a weekday its kept rule doesn't list would produce "that
// one Friday, plus every Tuesday" (RFC 5545) while reporting success. Only a
// *preserved* rule can contradict the caller this way — an explicit
// `recurrence` is the caller's own statement of intent.
const movedStartConflict = (
  args: UpdateCalendarEventArgs,
  rrule: string | undefined,
  start: Date,
  timeZone: string
): string | undefined => {
  if (!rrule || args.start === undefined || args.recurrence !== undefined) {
    return
  }
  return startContradictsRule(rrule, start, timeZone)
    ? `This series repeats on fixed weekdays (${rrule}), so moving its start alone would add one occurrence ` +
        'instead of moving the series. Pass `recurrence` with the new rule as well.'
    : undefined
}

// The stored state an occurrence edit merges against: a previously written
// override for the same instant if there is one, otherwise a synthetic base
// standing for the untouched occurrence — the instant `recurrenceId` names,
// running for the master's duration.
const occurrenceBase = (stored: ParsedEvent[], master: ParsedEvent | undefined, recurrenceId: string): EditBase => {
  const targetMs = Date.parse(recurrenceId)
  const existingOverride = stored.find((e) => e.recurrenceId !== undefined && Date.parse(e.recurrenceId) === targetMs)
  if (existingOverride) {
    return baseOf(existingOverride)
  }
  const base = baseOf(master)
  if (base.allDay && isDateOnly(base.start) && isDateOnly(base.end)) {
    // An all-day occurrence: the recurrenceId's date, for the master's length
    // in days (both UTC midnights, so the arithmetic is exact).
    const lengthMs = dateOnlyToInstant(base.end).getTime() - dateOnlyToInstant(base.start).getTime()
    return {
      ...base,
      end: instantToDateOnly(new Date(targetMs + lengthMs)),
      start: instantToDateOnly(new Date(targetMs)),
    }
  }
  if (base.start === undefined || base.end === undefined || !(hasClockTime(base.start) && hasClockTime(base.end))) {
    // DURATION-only master: the occurrence has no slot we can derive, and the
    // master's own DTSTART is the series' *first* day, not this occurrence's.
    // Drop both times so mergeSafetyError refuses unless the caller passes
    // `start` and `end`.
    const { end: _end, start: _start, ...rest } = base
    return rest
  }
  // The occurrence's own start/end, expressed exactly the way the master's are
  // — wall clock in the master's zone, or the `…Z` form when it has none — so
  // resolveEditFields reads them back identically.
  const floating = base.timeZone === undefined
  const zone = base.timeZone ?? UTC_TIME_ZONE
  const durationMs =
    resolveInputDateTime(base.end, zone, false).getTime() - resolveInputDateTime(base.start, zone, false).getTime()
  const zoned = (at: Date): string => `${toWallClockIso(at, zone)}${floating ? 'Z' : ''}`
  return { ...base, end: zoned(new Date(targetMs + durationMs)), start: zoned(new Date(targetMs)) }
}

// True when the master's EXDATEs cancel the instant `recurrenceId` names.
// Compared by instant, so a DATE exclusion matches the UTC midnight an
// all-day recurrenceId resolves to.
const isExcluded = (master: ParsedEvent, recurrenceId: string): boolean => {
  const targetMs = Date.parse(recurrenceId)
  return (master.excludedDates ?? []).some((excluded) => Date.parse(excluded) === targetMs)
}

// An edit that changes nothing but the reminder. It takes its own path
// (spliceAlarms) instead of the rebuild: a rebuild re-creates every ATTENDEE
// as NEEDS-ACTION and bumps SEQUENCE, so setting one's own reminder would wipe
// the guests' responses and re-invite them.
const isReminderOnly = (args: UpdateCalendarEventArgs): boolean =>
  args.reminderMinutesBefore !== undefined &&
  MUTATING_FIELDS.every((field) => field === 'reminderMinutesBefore' || args[field] === undefined)

// The reminder-only path for one occurrence. An existing override already
// holds that occurrence's attendee state, so its alarms are spliced like the
// whole event's. Without one, an override has to be created, which hands the
// occurrence to Stalwart's scheduler as a fresh REQUEST with every response
// reset — acceptable for a personal series (nobody to re-invite, so the
// caller falls through to the normal occurrence path) but not for one with
// attendees.
const occurrenceReminderPath = (
  stored: ParsedEvent[],
  master: ParsedEvent | undefined,
  recurrenceId: string
): 'splice' | 'rebuild' | 'refuse' => {
  const targetMs = Date.parse(recurrenceId)
  if (stored.some((e) => e.recurrenceId !== undefined && Date.parse(e.recurrenceId) === targetMs)) {
    return 'splice'
  }
  return (master?.attendees.length ?? 0) > 0 ? 'refuse' : 'rebuild'
}

const updateReminderOnly = async (
  deps: UpdateCalendarEventDeps,
  existing: CalendarObject,
  master: ParsedEvent | undefined,
  args: UpdateCalendarEventArgs,
  token: string,
  scope: ReminderScope
): Promise<ToolResult> => {
  const minutes = args.reminderMinutesBefore === NO_REMINDER ? null : (args.reminderMinutesBefore ?? null)
  const ical = spliceAlarms(existing.data, minutes, scope.kind === 'occurrence' ? scope.recurrenceId : undefined)
  await deps.updateEvent({ ical, token, url: existing.url, ...(existing.etag ? { etag: existing.etag } : {}) })
  return textResult(
    `Event "${master?.title ?? args.uid}" updated (no notifications sent${reminderSummary(args, master?.allDay === true)}); ` +
      REMINDER_SCOPE_NOTE[scope.kind]
  )
}

// What a reminder-only edit touched. On a series with individually changed
// occurrences the whole-event splice replaces their reminders too, so say so.
type ReminderScope = { kind: 'event' } | { kind: 'series' } | { kind: 'occurrence'; recurrenceId: string }
const REMINDER_SCOPE_NOTE = {
  event: 'only the reminder changed.',
  occurrence: 'only this occurrence’s reminder changed.',
  series: 'only the reminder changed, on the series and every occurrence, including individually changed ones.',
} as const

interface ReminderOnlyEdit {
  args: UpdateCalendarEventArgs
  deps: UpdateCalendarEventDeps
  existing: CalendarObject
  recurrenceId: string | undefined
  stored: ParsedEvent[]
  storedMaster: ParsedEvent | undefined
  token: string
}

// The result of a reminder-only edit, or undefined when the edit is not one
// (or is one for a personal series' un-overridden occurrence, which the
// normal occurrence path handles without anyone to re-invite).
const reminderOnlyResult = (e: ReminderOnlyEdit): Promise<ToolResult> | ToolResult | undefined => {
  if (!isReminderOnly(e.args)) {
    return
  }
  if (e.recurrenceId === undefined) {
    const kind = e.stored.length > 1 ? 'series' : 'event'
    return updateReminderOnly(e.deps, e.existing, e.storedMaster, e.args, e.token, { kind })
  }
  const path = occurrenceReminderPath(e.stored, e.storedMaster, e.recurrenceId)
  if (path === 'splice') {
    return updateReminderOnly(e.deps, e.existing, e.storedMaster, e.args, e.token, {
      kind: 'occurrence',
      recurrenceId: e.recurrenceId,
    })
  }
  if (path === 'refuse') {
    return errorResult(
      'This occurrence has no individual changes yet, so setting its reminder alone would re-send it to the ' +
        'attendees and reset their responses. Set the reminder on the whole series instead (omit `recurrenceId`). ' +
        'Nothing was changed.'
    )
  }
  return
}

// What the edit targets: the whole event (merging against the master), or —
// with `recurrenceId` — one occurrence, named by its normalized instant and
// merging against that occurrence's own stored state.
const editScope = (
  args: UpdateCalendarEventArgs,
  stored: ParsedEvent[],
  storedMaster: ParsedEvent | undefined
): { base: EditBase; recurrenceId?: string } | { error: string } => {
  if (args.recurrenceId === undefined) {
    return { base: baseOf(storedMaster) }
  }
  const recurrenceId = resolveRecurrenceId(args.recurrenceId, storedMaster)
  if (!recurrenceId.ok) {
    return { error: recurrenceId.error }
  }
  return { base: occurrenceBase(stored, storedMaster, recurrenceId.value), recurrenceId: recurrenceId.value }
}

interface RebuildEvent {
  args: UpdateCalendarEventArgs
  f: ResolvedFields
  // Discovered principal — the fallback when the stored object names nobody.
  organizer: string
  rrule?: string
  sequence: number
  stored: ParsedEvent[]
  timeZone: string
}

// Serializes the whole-event edit as a single VEVENT.
const rebuildEvent = ({ args, f, organizer, rrule, sequence, stored, timeZone }: RebuildEvent): string =>
  buildInvite({
    alarms: f.alarms,
    allDay: f.allDay,
    attendees: f.attendees,
    end: f.end,
    // Keep the stored ORGANIZER (see updateOccurrence): re-stamping the freshly
    // discovered principal onto an event created under a previous account
    // address silently changes the organizer, which Stalwart's scheduler treats
    // as an unsupported organizer replacement (RFC 6638).
    organizer: stored.find((e) => e.organizer)?.organizer ?? organizer,
    // Bump past the stored SEQUENCE so the re-sent REQUEST supersedes it.
    sequence,
    start: f.start,
    timeZone,
    title: f.title,
    uid: args.uid,
    ...(f.description ? { description: f.description } : {}),
    ...(f.location ? { location: f.location } : {}),
    ...(rrule ? { rrule } : {}),
    ...(f.scheduleAgent ? { scheduleAgent: f.scheduleAgent } : {}),
  })

export const updateCalendarEvent = async (
  deps: UpdateCalendarEventDeps,
  ctx: UpdateCalendarEventContext
): Promise<ToolResult> => {
  const { args, token } = ctx

  // A delta edit names the attendees to add/remove instead of the whole list.
  const isDelta = args.addedAttendees !== undefined || args.removedAttendees !== undefined

  const comboError = combinationError(args, isDelta)
  if (comboError) {
    return errorResult(comboError)
  }

  const account = await deps.discover(token)
  if (!account.organizer) {
    return errorResult('Could not determine an organizer address for this account.')
  }

  const resolved = resolveCalendarUrl(account, args.calendarUrl)
  if (!resolved.ok) {
    return errorResult(
      resolved.reason === 'none'
        ? 'No calendar available to update the event in.'
        : `Calendar not found: ${args.calendarUrl}`
    )
  }

  const existing = await deps.fetchEvent({ calendarUrl: resolved.url, token, uid: args.uid })
  if (!existing) {
    return errorResult(`Event not found: ${args.uid}`)
  }
  const stored = parseEvents(existing.data)
  const storedMaster = stored.find((e) => e.recurrence !== undefined) ?? stored[0]

  const timeZone = args.timeZone ?? storedMaster?.startTzid ?? (await deps.resolveTimeZone(token)) ?? UTC_TIME_ZONE

  const scope = editScope(args, stored, storedMaster)
  if ('error' in scope) {
    return errorResult(`${scope.error} Nothing was changed.`)
  }
  const { base, recurrenceId } = scope

  const reminderOnly = await reminderOnlyResult({ args, deps, existing, recurrenceId, stored, storedMaster, token })
  if (reminderOnly) {
    return reminderOnly
  }

  const unsafe = mergeSafetyError(stored, base, args)
  if (unsafe) {
    return errorResult(unsafe)
  }

  const fields = resolveEditFields(args, isDelta, base, timeZone)
  if (!fields.ok) {
    return errorResult(`${fields.error} Nothing was changed.`)
  }
  const f = fields.value
  const removed = removedAttendees(base.attendees, f.attendees)

  if (recurrenceId !== undefined) {
    return updateOccurrence({
      args,
      deps,
      existing,
      organizer: account.organizer,
      recurrenceId,
      removedAttendees: removed,
      timeZone,
      token,
      ...f,
    })
  }

  const rrule = resolveRrule(args, base, f.allDay, timeZone)
  // All-day dates are UTC midnights, so their weekday is read in UTC.
  const ruleConflict = movedStartConflict(args, rrule, f.start, f.allDay ? UTC_TIME_ZONE : timeZone)
  if (ruleConflict) {
    return errorResult(ruleConflict)
  }
  const sequence = parseSequence(existing.data) + 1
  const ical = rebuildEvent({
    args,
    f,
    organizer: account.organizer,
    sequence,
    stored,
    timeZone,
    ...(rrule ? { rrule } : {}),
  })

  await deps.updateEvent({ ical, token, url: existing.url, ...(existing.etag ? { etag: existing.etag } : {}) })
  logSchedulingHandover({
    attendees: f.attendees,
    ical,
    removedAttendees: removed,
    scheduleAgent: f.scheduleAgent,
    sequence,
    uid: args.uid,
  })

  await deps.collectAttendees?.({
    attendees: attendeesWithStoredNames(f.attendees, storedMaster),
    // The same stored-organizer preference rebuildEvent applies, so the
    // collected card credits whoever actually owns the event.
    organizer: stored.find((e) => e.organizer)?.organizer ?? account.organizer,
    selfAddress: account.organizer,
    start: f.start.toISOString(),
    token,
    uid: args.uid,
  })

  return textResult(
    `${rrule ? 'Recurring event' : 'Event'} "${f.title}" updated ` +
      `(${deliverySummary(f.attendees, f.scheduleAgent, removed.length > 0)}${reminderSummary(args, f.allDay)}).`
  )
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (
  cfg: CalDavConfig,
  // Shared across the calendar tools (see mcp/handler.ts) so create→update reuse
  // one per-token cache; defaults to a fresh resolver for standalone callers.
  resolveTimeZone: AccountTimeZoneResolver = makeAccountTimeZoneResolver({ serverUrl: cfg.serverUrl }),
  collectAttendees?: AttendeeWriteThrough
): UpdateCalendarEventDeps => ({
  discover: (token) => discoverAccount(cfg, token),
  fetchEvent: (params) => fetchEvent(cfg, params),
  resolveTimeZone,
  updateEvent: (params) => updateEvent(cfg, params),
  ...(collectAttendees ? { collectAttendees } : {}),
})

// --- MCP registration ----------------------------------------------------

export const registerUpdateCalendarEvent = (
  server: McpServer,
  deps: UpdateCalendarEventDeps,
  // Bearer threaded per request — see mcp/handler.ts.
  getToken: () => string
): void => {
  server.registerTool(
    'update_calendar_event',
    {
      annotations: OUTWARD_DESTRUCTIVE,
      // Kept short and front-loaded with the words a user actually types
      // ("update", "edit", "reschedule", "move", "change the time", "add
      // attendees"): tool search ranks this string plus the argument
      // descriptions, and BM25 penalises long documents. Edge-case semantics
      // live in the error messages and on the docs site, not here.
      description:
        'Update, edit or reschedule an existing calendar event or meeting: move it to a new time, ' +
        'change the time or title, set the location, or add and remove attendees. Pass the event `uid` ' +
        '(from list_calendar_events or create_calendar_event) plus only the fields to change — every ' +
        'field you omit keeps its stored value, so rescheduling needs nothing but `uid` and `start`. ' +
        'All-day events stay all-day; pass `start`/`end` as dates or date-times to switch. Set or clear ' +
        'a reminder with `reminderMinutesBefore`. ' +
        'Attendees are re-notified by iMIP unless you pass `notify: "none"`. To change one occurrence ' +
        'of a repeating series instead of the whole series, pass `recurrenceId`. To rename or recolor ' +
        'a calendar itself, use update_calendar. To put an event on a different calendar, use ' +
        'move_calendar_events.',
      inputSchema: updateCalendarEventInput.shape,
      title: 'Update calendar event',
    },
    (args) => {
      const parsed = updateCalendarEventInput.parse(args)
      return updateCalendarEvent(deps, { args: parsed, token: getToken() })
    }
  )
}
