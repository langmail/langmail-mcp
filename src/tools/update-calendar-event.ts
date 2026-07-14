// update_calendar_event tool — replaces an existing VEVENT in place and
// re-sends DKIM-signed iMIP invitations with a bumped SEQUENCE, so the
// attendees' clients treat it as an update rather than a new invite.
//
// The edit is a full re-specification of the event (title/time/attendees),
// addressed by the stable UID returned from create_calendar_event. We fetch
// the current object to confirm it exists, read its SEQUENCE, and PUT the
// rebuilt iCal back to the same URL with the original ETag.
//
// Two edit modes, chosen by `recurrenceId`:
//   - omitted → the whole event (the entire series for a recurring one), exactly
//     as before;
//   - present → a single occurrence of a recurring series, written as a
//     RECURRENCE-ID override spliced alongside the untouched master (see
//     caldav/occurrence.ts). Stalwart then schedules an iMIP update scoped to
//     that instance.
//
// Logic sits behind a `Deps` interface (discover + fetchEvent + updateEvent)
// so it unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  type CalDavConfig,
  discoverAccount,
  type FetchEventParams,
  fetchEvent,
  resolveCalendarUrl,
  type UpdateEventParams,
  updateEvent,
} from '../caldav/client.ts'
import { buildInvite, maxSequence, parseSequence } from '../caldav/ical.ts'
import { parseEvents } from '../caldav/ical-parse.ts'
import { spliceOccurrenceOverride } from '../caldav/occurrence.ts'
import { isSeriesOccurrence, toRRule } from '../caldav/recurrence.ts'
import { type CalendarObject, type DiscoveredAccount } from '../caldav/types.ts'
import { createCalendarEventInput, eventUidSchema } from './create-calendar-event.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const recurrenceIdDescription =
  'Optional ISO 8601 instant that scopes this edit to a single occurrence of a ' +
  'recurring series, identified by that occurrence’s original start (e.g. ' +
  '2026-06-16T10:00:00Z). When set, only that occurrence changes — the master ' +
  'rule and every other occurrence stay exactly as they are — and start/end ' +
  'become the occurrence’s new time (pass the same instant here and in start to ' +
  'keep the time and change only other fields). The instant must land on an ' +
  'actual occurrence of the series. Omit to edit the whole event. Cannot be ' +
  'combined with `recurrence`.'

export const updateCalendarEventInput = createCalendarEventInput.extend({
  recurrenceId: z.iso.datetime({ offset: true }).optional().describe(recurrenceIdDescription),
  uid: eventUidSchema,
})

export type UpdateCalendarEventArgs = z.infer<typeof updateCalendarEventInput>

export interface UpdateCalendarEventDeps {
  discover: (token: string) => Promise<DiscoveredAccount>
  fetchEvent: (params: FetchEventParams) => Promise<CalendarObject | null>
  updateEvent: (params: UpdateEventParams) => Promise<void>
}

export interface UpdateCalendarEventContext {
  args: UpdateCalendarEventArgs
  token: string
}

// Everything the single-occurrence path needs once the common preamble
// (organizer + calendar + existence checks) has passed.
interface OccurrenceUpdate {
  args: UpdateCalendarEventArgs
  deps: UpdateCalendarEventDeps
  end: Date
  existing: CalendarObject
  // Bare organizer email — already confirmed non-null by the caller.
  organizer: string
  recurrenceId: string
  start: Date
  token: string
}

// Edits one occurrence of a recurring series: validate the target instant
// against the master's RRULE, build a RECURRENCE-ID override, and splice it into
// the stored object alongside the untouched master before PUTting it back.
const updateOccurrence = async (u: OccurrenceUpdate): Promise<ToolResult> => {
  const { args, deps, end, existing, organizer, recurrenceId, start, token } = u

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
    onOccurrence = isSeriesOccurrence(master.start, master.recurrence, recurrenceId)
  } catch {
    return errorResult(
      `Could not evaluate this series' recurrence rule (${master.recurrence}) to validate ` +
        `recurrenceId ${recurrenceId}.`
    )
  }
  if (!onOccurrence) {
    return errorResult(
      `recurrenceId ${recurrenceId} does not match an occurrence of this series ` +
        `(${master.recurrence}); it must equal an occurrence’s original start.`
    )
  }

  const override = buildInvite({
    attendees: args.attendees,
    end,
    organizer,
    recurrenceId: new Date(recurrenceId),
    // Bump past every SEQUENCE already in the object so this override supersedes
    // any prior edit of the same instance.
    sequence: maxSequence(existing.data) + 1,
    start,
    title: args.title,
    uid: args.uid,
    ...(args.description ? { description: args.description } : {}),
    ...(args.location ? { location: args.location } : {}),
  })
  const ical = spliceOccurrenceOverride(existing.data, override, recurrenceId)

  await deps.updateEvent({ ical, token, url: existing.url, ...(existing.etag ? { etag: existing.etag } : {}) })

  return textResult(
    `Occurrence of "${args.title}" on ${recurrenceId} updated and notifications sent ` +
      `to ${args.attendees.length} attendee(s): ${args.attendees.join(', ')}. ` +
      'The rest of the series is unchanged.'
  )
}

export const updateCalendarEvent = async (
  deps: UpdateCalendarEventDeps,
  ctx: UpdateCalendarEventContext
): Promise<ToolResult> => {
  const { args, token } = ctx

  // The two modes are contradictory: `recurrence` re-rules the whole series,
  // `recurrenceId` edits a single occurrence. Reject the ambiguous combination
  // rather than silently favouring one.
  if (args.recurrenceId !== undefined && args.recurrence !== undefined) {
    return errorResult(
      'Pass either `recurrence` (to re-rule the whole series) or `recurrenceId` ' +
        '(to edit a single occurrence), not both.'
    )
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
  const calendarUrl = resolved.url

  const start = new Date(args.start)
  const end = new Date(args.end)
  if (end <= start) {
    return errorResult('Event end must be after its start.')
  }

  const existing = await deps.fetchEvent({ calendarUrl, token, uid: args.uid })
  if (!existing) {
    return errorResult(`Event not found: ${args.uid}`)
  }

  if (args.recurrenceId !== undefined) {
    return updateOccurrence({
      args,
      deps,
      end,
      existing,
      organizer: account.organizer,
      recurrenceId: args.recurrenceId,
      start,
      token,
    })
  }

  // Full re-specification: a recurrence given here re-rules the whole series;
  // omitting it drops the RRULE and collapses the series to a single event.
  const rrule = args.recurrence ? toRRule(args.recurrence) : undefined
  const ical = buildInvite({
    attendees: args.attendees,
    end,
    organizer: account.organizer,
    // Bump past the stored SEQUENCE so the re-sent REQUEST supersedes it.
    sequence: parseSequence(existing.data) + 1,
    start,
    title: args.title,
    uid: args.uid,
    ...(args.description ? { description: args.description } : {}),
    ...(args.location ? { location: args.location } : {}),
    ...(rrule ? { rrule } : {}),
  })

  await deps.updateEvent({ ical, token, url: existing.url, ...(existing.etag ? { etag: existing.etag } : {}) })

  return textResult(
    `${rrule ? 'Recurring event' : 'Event'} "${args.title}" updated and notifications sent ` +
      `to ${args.attendees.length} attendee(s): ${args.attendees.join(', ')}.`
  )
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (cfg: CalDavConfig): UpdateCalendarEventDeps => ({
  discover: (token) => discoverAccount(cfg, token),
  fetchEvent: (params) => fetchEvent(cfg, params),
  updateEvent: (params) => updateEvent(cfg, params),
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
      description:
        'Updates an existing calendar event (identified by its uid from ' +
        'create_calendar_event) and re-sends iMIP notifications to the attendees. ' +
        'This is a full replacement: pass the complete event details, not just the ' +
        'changed fields. By default this edits the ENTIRE event — for a recurring ' +
        'event that means every occurrence, so to keep it recurring pass ' +
        '`recurrence` again; omitting it collapses the series back to a single ' +
        'event. To instead edit ONE occurrence in isolation (e.g. a per-week agenda ' +
        'on a recurring meeting), pass `recurrenceId` naming that occurrence by its ' +
        'original start; the master rule and every other occurrence stay unchanged. ' +
        'Times are ISO 8601 with offset (e.g. 2026-06-12T10:00:00Z).',
      inputSchema: updateCalendarEventInput.shape,
      title: 'Update calendar event',
    },
    (args) => {
      const parsed = updateCalendarEventInput.parse(args)
      return updateCalendarEvent(deps, { args: parsed, token: getToken() })
    }
  )
}
