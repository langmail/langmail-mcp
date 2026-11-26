// delete_calendar_event tool — removes an existing VEVENT from a CalDAV
// calendar, addressed by the stable UID from create_calendar_event. Deleting
// an organizer's scheduling object makes Stalwart fan out DKIM-signed iMIP
// CANCEL messages to the attendees (RFC 6638 server-side scheduling), so we
// don't build a cancellation iCal ourselves. At Change, never send a narrowed
// form deletes only events nobody else is on (personal-event.ts).
//
// We fetch the object first to confirm it exists (and pick up its ETag) before
// acting. Two modes, chosen by `recurrenceId`:
//   - omitted → the whole event (the entire series for a recurring one): a
//     conditional DAV DELETE of the resource, exactly as before;
//   - present → a single occurrence of a recurring series: the `.ics` resource
//     must survive (it still holds the master and the other occurrences), so
//     instead of DELETEing we exclude the instant on the master with an EXDATE
//     (see caldav/occurrence.ts) and PUT the object back. Stalwart then diffs
//     the scheduling object (RFC 6638) and fans out an iMIP update to the
//     attendees. NB (verified against Stalwart 1.0 — see
//     stalwart-cancel-occurrence.test.ts): the fan-out is a per-instance
//     METHOD:CANCEL whose RECURRENCE-ID names the excluded instant (RFC 5546
//     §3.2.5), so the attendee client drops just that occurrence and keeps the
//     series. Stalwart 0.16 sent an updated-series REQUEST carrying the EXDATE
//     instead. The bumped master SEQUENCE keeps either form newer than the
//     invitation (RFC 5546). Either way we build no scheduling message
//     ourselves — same philosophy as the whole-series path.
//
// Logic sits behind a `Deps` interface (discover + fetchEvent + deleteEvent +
// updateEvent) so it unit-tests without live Stalwart; `makeLiveDeps` wires
// tsdav in.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { type AccessLevel, reachesOthers } from '../access/levels.ts'
import { type Narrowed } from '../access/narrowed.ts'
import {
  type CalDavConfig,
  type DeleteEventParams,
  deleteEvent,
  discoverAccount,
  type FetchEventParams,
  fetchEvent,
  resolveCalendarUrl,
  type UpdateEventParams,
  updateEvent,
} from '../caldav/client.ts'
import { spliceOccurrenceCancellation } from '../caldav/occurrence.ts'
import { isSeriesOccurrence, resolveRecurrenceId, seriesTimeZone } from '../caldav/recurrence.ts'
import { type CalendarObject, type DiscoveredAccount } from '../caldav/types.ts'
import { parseEvents } from '../ical/index.ts'
import { type ServerMode } from '../mode.ts'
import { ACCOUNT_DESTRUCTIVE, OUTWARD_DESTRUCTIVE } from './annotations.ts'
import { eventUidSchema } from './create-calendar-event.ts'
import { hasOtherPeople, meetingRefusal } from './personal-event.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const recurrenceIdDescription =
  'Optional ISO 8601 instant that scopes this deletion to a single occurrence of ' +
  'a recurring series, identified by that occurrence’s original start (e.g. ' +
  '2026-06-16T10:00:00Z), or its date for an all-day series (2026-06-16). When set, only that one occurrence is cancelled — the ' +
  'master rule and every other occurrence stay exactly as they are — and ' +
  'attendees get a cancellation scoped to just that instance. The instant must ' +
  'land on an actual occurrence of the series. Omit to delete the whole event ' +
  '(for a recurring event, the entire series).'

export const deleteCalendarEventInput = z.object({
  // Optional CalDAV URL from list_calendars; defaults to the principal's
  // discovered default calendar (where create_calendar_event also lands).
  calendarUrl: z.url().optional(),
  recurrenceId: z
    .union([z.iso.date(), z.iso.datetime({ offset: true })])
    .optional()
    .describe(recurrenceIdDescription),
  uid: eventUidSchema,
})

export type DeleteCalendarEventArgs = z.infer<typeof deleteCalendarEventInput>

// The form an agent at Change, never send gets (src/access/levels.ts): the same
// fields, described for a personal event, which nobody is told about.
export const deletePersonalEventInput = z.strictObject({
  ...deleteCalendarEventInput.shape,
  recurrenceId: deleteCalendarEventInput.shape.recurrenceId.describe(
    'Optional ISO 8601 instant that scopes this deletion to a single occurrence of a recurring series, ' +
      'identified by that occurrence’s original start (e.g. 2026-06-16T10:00:00Z), or its date for an ' +
      'all-day series (2026-06-16). Only that occurrence is removed; the rule and every other occurrence ' +
      'stay. Omit to delete the whole event (for a recurring event, the entire series).'
  ),
})

export interface DeleteCalendarEventDeps {
  deleteEvent: (params: DeleteEventParams) => Promise<void>
  discover: (token: string) => Promise<DiscoveredAccount>
  fetchEvent: (params: FetchEventParams) => Promise<CalendarObject | null>
  updateEvent: (params: UpdateEventParams) => Promise<void>
}

export interface DeleteCalendarEventContext {
  args: DeleteCalendarEventArgs
  // Set at Change, never send: an event with attendees is refused.
  narrowed?: Narrowed
  token: string
}

// Everything the single-occurrence path needs once the calendar + existence
// checks have passed.
interface OccurrenceCancellation {
  args: DeleteCalendarEventArgs
  deps: DeleteCalendarEventDeps
  existing: CalendarObject
  personal: boolean
  recurrenceId: string
  token: string
}

// Cancels one occurrence of a recurring series: validate the target instant
// against the master's RRULE, exclude it on the master with an EXDATE, and PUT
// the object back (never DELETE — the resource still holds the master and the
// other occurrences). Unlike the update-tool's occurrence path this writes no
// ORGANIZER or any other VEVENT field — it only excludes an instant — so there
// is nothing an organizer check would validate and none is needed.
const cancelOccurrence = async (c: OccurrenceCancellation): Promise<ToolResult> => {
  const { args, deps, existing, token } = c

  // The stored object holds the master (the only VEVENT with an RRULE) plus any
  // overrides. The master identifies the series we validate against.
  const master = parseEvents(existing.data).find((e) => e.recurrence !== undefined)
  if (!master?.recurrence) {
    return errorResult(`Event ${args.uid} is not a recurring series; omit recurrenceId to delete it.`)
  }
  const resolved = resolveRecurrenceId(c.recurrenceId, master)
  if (!resolved.ok) {
    return errorResult(`${resolved.error} Nothing was cancelled.`)
  }
  const recurrenceId = resolved.value

  const zone = seriesTimeZone(master, c.recurrenceId)
  if (!zone.ok) {
    return errorResult(`${zone.error} Nothing was cancelled.`)
  }

  // A raw master RRULE is only lightly validated on create, so `rrule` may
  // reject one Stalwart happily stored. Treat an unparseable rule as a clean
  // rejection rather than an opaque crash — mirrors update_calendar_event.
  let onOccurrence: boolean
  try {
    onOccurrence = isSeriesOccurrence(master.start, master.recurrence, recurrenceId, zone.value)
  } catch {
    return errorResult(
      `Could not evaluate this series' recurrence rule (${master.recurrence}) to validate ` +
        `recurrenceId ${c.recurrenceId}.`
    )
  }
  if (!onOccurrence) {
    return errorResult(
      `recurrenceId ${c.recurrenceId} does not match an occurrence of this series ` +
        `(${master.recurrence}); it must equal an occurrence’s original ${master.allDay ? 'date' : 'start'}. ` +
        'Nothing was cancelled. Use list_calendar_events to see the series.'
    )
  }

  const ical = spliceOccurrenceCancellation(existing.data, recurrenceId, master.allDay === true)
  // A double-cancel leaves the object byte-for-byte unchanged (the instant is
  // already excluded): skip the PUT — no scheduling diff, no round-trip — while
  // still reporting success, so "cancel today's standup" twice is not an error.
  if (ical !== existing.data) {
    await deps.updateEvent({ ical, token, url: existing.url, ...(existing.etag ? { etag: existing.etag } : {}) })
  }

  if (c.personal) {
    return textResult(
      `Occurrence of ${args.uid} on ${c.recurrenceId} removed; nobody else is on this event. ` +
        'The rest of the series is unchanged.'
    )
  }
  return textResult(
    `Occurrence of ${args.uid} on ${c.recurrenceId} cancelled; attendees are notified so ` +
      'just that instance is removed from their calendars. The rest of the series is unchanged.'
  )
}

export const deleteCalendarEvent = async (
  deps: DeleteCalendarEventDeps,
  ctx: DeleteCalendarEventContext
): Promise<ToolResult> => {
  const { args, token } = ctx
  const account = await deps.discover(token)

  const resolved = resolveCalendarUrl(account, args.calendarUrl)
  if (!resolved.ok) {
    return errorResult(
      resolved.reason === 'none'
        ? 'No calendar available to delete the event from.'
        : `Calendar not found: ${args.calendarUrl}`
    )
  }
  const calendarUrl = resolved.url

  const existing = await deps.fetchEvent({ calendarUrl, token, uid: args.uid })
  if (!existing) {
    return errorResult(`Event not found: ${args.uid}`)
  }
  // Without an own address every attendee counts as someone else.
  if (ctx.narrowed && hasOtherPeople(parseEvents(existing.data), account.organizer ?? '')) {
    return errorResult(meetingRefusal(args.uid, ctx.narrowed))
  }
  const personal = ctx.narrowed !== undefined

  if (args.recurrenceId !== undefined) {
    return cancelOccurrence({ args, deps, existing, personal, recurrenceId: args.recurrenceId, token })
  }

  await deps.deleteEvent({ token, url: existing.url, ...(existing.etag ? { etag: existing.etag } : {}) })

  if (personal) {
    return textResult(`Event ${args.uid} deleted; nobody else was on it.`)
  }
  return textResult(`Event ${args.uid} deleted; Stalwart will send cancellations to any attendees.`)
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (cfg: CalDavConfig): DeleteCalendarEventDeps => ({
  deleteEvent: (params) => deleteEvent(cfg, params),
  discover: (token) => discoverAccount(cfg, token),
  fetchEvent: (params) => fetchEvent(cfg, params),
  updateEvent: (params) => updateEvent(cfg, params),
})

// --- MCP registration ----------------------------------------------------

export const registerDeleteCalendarEvent = (
  server: McpServer,
  deps: DeleteCalendarEventDeps,
  // Bearer threaded per request — see mcp/handler.ts.
  getToken: () => string,
  access: AccessLevel,
  mode: ServerMode = 'hosted'
): void => {
  if (!reachesOthers(access)) {
    server.registerTool(
      'delete_calendar_event',
      {
        annotations: ACCOUNT_DESTRUCTIVE,
        description:
          'Delete or remove a personal event from the user’s calendar, one nobody else is on, identified ' +
          'by its uid from create_calendar_event or list_calendar_events. Cancelling a meeting with other ' +
          'people, or declining an invitation, needs Everything access. By default this deletes the ENTIRE ' +
          'event, for a recurring event every occurrence; pass recurrenceId to remove ONE occurrence. ' +
          'Defaults to the user’s default calendar; pass calendarUrl if the event lives in another calendar.',
        inputSchema: deletePersonalEventInput,
        title: 'Delete calendar event',
      },
      (args) =>
        deleteCalendarEvent(deps, {
          args: deletePersonalEventInput.parse(args),
          narrowed: { mode },
          token: getToken(),
        })
    )
    return
  }
  server.registerTool(
    'delete_calendar_event',
    {
      annotations: OUTWARD_DESTRUCTIVE,
      description:
        'Cancel, delete or remove a calendar event or meeting the user organizes, identified by its uid ' +
        'from create_calendar_event or list_calendar_events, and send iMIP cancellations to its attendees. ' +
        '(To decline an invitation someone else sent, use respond_to_event instead.) ' +
        'By default this deletes the ' +
        'ENTIRE event — for a recurring event that means every occurrence. To instead ' +
        'cancel ONE occurrence of a recurring series (e.g. skip this week’s standup), ' +
        'pass recurrenceId naming that occurrence by its original start; the master ' +
        'rule and every other occurrence stay unchanged. Defaults to the user’s default ' +
        'calendar; pass calendarUrl if the event lives in another calendar.',
      inputSchema: deleteCalendarEventInput,
      title: 'Delete calendar event',
    },
    (args) => {
      const parsed = deleteCalendarEventInput.parse(args)
      return deleteCalendarEvent(deps, { args: parsed, token: getToken() })
    }
  )
}
