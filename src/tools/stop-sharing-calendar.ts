// stop_sharing_calendar tool — stops a person's share of one calendar, or of
// every calendar when none is named. Deleting the share kills its link for
// good: the feed answers an empty calendar from then on. Nobody else's share
// changes.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { ACCOUNT_DESTRUCTIVE } from './annotations.ts'
import { calendarLabel, resolveCalendar } from './calendar-lookup.ts'
import {
  type CalendarSharingContext,
  type CalendarSharingDeps,
  describeShare,
  SHARING_OFF,
  sameLabel,
  shareLines,
  sharesOn,
} from './calendar-share-common.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const stopSharingCalendarShape = {
  calendar: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'The calendar to stop sharing: its name (matched ignoring case) or its URL, as list_calendars shows ' +
        'them. Omit it to stop every share with this person.'
    ),
  with: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      'The person, by the name the calendar was shared with (matched ignoring case), as list_calendars shows it.'
    ),
}

export const stopSharingCalendarInput = z.object(stopSharingCalendarShape)

export type StopSharingCalendarArgs = z.infer<typeof stopSharingCalendarInput>

export const stopSharingCalendar = async (
  deps: CalendarSharingDeps,
  ctx: CalendarSharingContext & { args: StopSharingCalendarArgs }
): Promise<ToolResult> => {
  const { args, token, userId } = ctx
  if (!deps.shares) {
    return errorResult(`${SHARING_OFF} Nothing was stopped.`)
  }
  const calendars = await deps.listCalendars(token)
  const shares = await deps.shares.list(userId)

  let scope = shares
  let where = ''
  if (args.calendar !== undefined) {
    const resolved = resolveCalendar(calendars, args.calendar, {
      argName: 'calendar',
      nothingDone: 'Nothing was stopped.',
    })
    if (!resolved.ok) {
      return resolved.error
    }
    scope = sharesOn(shares, resolved.calendar)
    where = ` on "${calendarLabel(resolved.calendar)}"`
  }

  const stopped = scope.filter((s) => sameLabel(s.label, args.with))
  if (stopped.length === 0) {
    return errorResult(`No share with ${args.with}${where}. Nothing was stopped. ${shareLines(shares, calendars)}`)
  }
  await deps.shares.remove(
    userId,
    stopped.map((s) => s.id)
  )
  const lines = stopped.map((s) => `- ${describeShare(s, calendars)}`).join('\n')
  return textResult(
    `Stopped ${stopped.length} share(s):\n${lines}\n` +
      `${args.with}’s link now shows an empty calendar, for good. No other share changed.`
  )
}

// --- MCP registration ----------------------------------------------------

export const registerStopSharingCalendar = (
  server: McpServer,
  deps: CalendarSharingDeps,
  // Bearer and user id threaded per request — see mcp/handler.ts.
  getToken: () => string,
  getUserId: () => string
): void => {
  server.registerTool(
    'stop_sharing_calendar',
    {
      annotations: ACCOUNT_DESTRUCTIVE,
      description:
        'Stops sharing the user’s calendar with a person, so the link they were given shows an empty ' +
        'calendar from then on. Use this when the user wants someone to no longer see a calendar. Name ' +
        'the person as the share was made; name a calendar to stop only that one, or leave it out to stop ' +
        'every share with that person. Returns the shares stopped; other people’s shares are unchanged. ' +
        'When nothing matches, the error lists every current share and nothing is stopped. A stopped link ' +
        'cannot be revived: to share again, use share_calendar, which gives a new link. To see the current ' +
        'shares use list_calendars.',
      inputSchema: z.object(stopSharingCalendarShape),
      title: 'Stop sharing calendar',
    },
    (args) =>
      stopSharingCalendar(deps, {
        args: stopSharingCalendarInput.parse(args),
        token: getToken(),
        userId: getUserId(),
      })
  )
}
