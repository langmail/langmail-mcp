// share_calendar tool — shares one of the user's calendars with a person
// outside Langmail, at busy-only or full detail, and hands back the secret
// link that person subscribes to (served by calendar-feeds/feed.ts).
//
// One share per calendar and person: sharing again changes the level and
// keeps the link. Only the secret's hash is stored, so the link is in this
// result and nowhere else.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { mintShareSecret, shareLink } from '../calendar-feeds/shares.ts'
import { OUTWARD_WRITE } from './annotations.ts'
import { calendarLabel, resolveCalendar } from './calendar-lookup.ts'
import {
  type CalendarSharingContext,
  type CalendarSharingDeps,
  calendarPath,
  levelWords,
  SHARING_OFF,
  sameLabel,
  sharesOn,
} from './calendar-share-common.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const shareCalendarShape = {
  calendar: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The calendar to share: its name (matched ignoring case) or its URL, both as list_calendars shows them. ' +
        'Use the URL when two calendars share a name.'
    ),
  level: z
    .enum(['busy', 'full'])
    .describe(
      '"busy": the person sees only when the user is busy, every event titled "Busy". ' +
        '"full": titles, times, locations, notes and guests; private events still show as busy. ' +
        'Ask the user when they have not said which.'
    ),
  with: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      'Who the calendar is shared with, as the user names them: "Sam", "my partner". A label only; ' +
        'Langmail sends nothing to this person. Sharing the same calendar again with the same label ' +
        '(ignoring case) changes that share’s level.'
    ),
}

export const shareCalendarInput = z.object(shareCalendarShape)

export type ShareCalendarArgs = z.infer<typeof shareCalendarInput>

const LEVEL_SHOWS = {
  busy: 'they see when you are busy, with every event titled "Busy" and no details',
  full: 'they see titles, times, locations, notes and guests; private events show only as busy',
} as const

const howToAdd = (person: string): string =>
  [
    `How ${person} adds it:`,
    '- Google Calendar (on a computer): Other calendars → + → From URL, then paste the link.',
    '- Apple Calendar: on a Mac, File → New Calendar Subscription; on an iPhone, Settings → Apps → Calendar → ' +
      'Calendar Accounts → Add Account → Other → Add Subscribed Calendar.',
    '- Outlook: Add calendar → Subscribe from web, then paste the link.',
    '',
    `How often the calendar refreshes is up to ${person}’s app, not Langmail: Google Calendar picks up ` +
      'changes every few hours, sometimes only once a day; Apple Calendar and Outlook refresh every few hours ' +
      'or as the subscriber sets.',
  ].join('\n')

export const shareCalendar = async (
  deps: CalendarSharingDeps,
  ctx: CalendarSharingContext & { args: ShareCalendarArgs }
): Promise<ToolResult> => {
  const { args, token, userId } = ctx
  if (!deps.shares) {
    return errorResult(`${SHARING_OFF} Nothing was shared.`)
  }
  const calendars = await deps.listCalendars(token)
  const resolved = resolveCalendar(calendars, args.calendar, {
    argName: 'calendar',
    nothingDone: 'Nothing was shared.',
  })
  if (!resolved.ok) {
    return resolved.error
  }
  const calendar = resolved.calendar
  const name = calendarLabel(calendar)
  const person = args.with

  const existing = sharesOn(await deps.shares.list(userId), calendar).find((s) => sameLabel(s.label, person))
  if (existing) {
    const keep =
      `${existing.label}’s existing link keeps working, so there is nothing new to pass on. ` +
      'Langmail cannot show that link again; if it is lost, stop_sharing_calendar and share again for a new one.'
    if (existing.level === args.level) {
      return textResult(
        `"${name}" is already shared with ${existing.label} at ${levelWords(args.level)}. Nothing changed. ${keep}`
      )
    }
    await deps.shares.setLevel(userId, existing.id, args.level)
    return textResult(
      `"${name}" is now shared with ${existing.label} at ${levelWords(args.level)} (was ${levelWords(existing.level)}): ` +
        `${LEVEL_SHOWS[args.level]}. ${keep} The change shows the next time their app refreshes.`
    )
  }

  const { secret, secretHash } = mintShareSecret()
  await deps.shares.create(userId, {
    calendarUrl: calendarPath(calendar.url),
    label: person,
    level: args.level,
    secretHash,
  })
  return textResult(
    [
      `Shared "${name}" with ${person} at ${levelWords(args.level)}: ${LEVEL_SHOWS[args.level]}.`,
      '',
      `Link for ${person}: ${shareLink(deps.publicUrl, secret)}`,
      '',
      'This is the only time Langmail shows this link. Anyone who has it can see the calendar, so pass it on ' +
        `to ${person} only. If it gets lost, stop_sharing_calendar with ${person} and share again for a new link.`,
      '',
      howToAdd(person),
    ].join('\n')
  )
}

// --- MCP registration ----------------------------------------------------

export const registerShareCalendar = (
  server: McpServer,
  deps: CalendarSharingDeps,
  // Bearer and user id threaded per request — see mcp/handler.ts.
  getToken: () => string,
  getUserId: () => string
): void => {
  server.registerTool(
    'share_calendar',
    {
      annotations: OUTWARD_WRITE,
      description:
        'Shares one of the user’s calendars with a person, at busy times only or full details, and returns ' +
        'a secret link that person adds in Google Calendar, Apple Calendar or Outlook; the calendar stays ' +
        'live behind it. Use this when the user wants someone to see their calendar or their availability. ' +
        'Returns the link, what the person will see, how to add it in each app, and that their app decides ' +
        'how often it refreshes: relay all of it. The link is shown only in this result and cannot be shown ' +
        'again. Langmail does not send it; to email it, stage a draft with create_draft. Sharing the same ' +
        'calendar with the same person again changes the level and keeps their link. To see who can see ' +
        'which calendar use list_calendars; to stop a share use stop_sharing_calendar.',
      inputSchema: z.object(shareCalendarShape),
      title: 'Share calendar',
    },
    (args) => shareCalendar(deps, { args: shareCalendarInput.parse(args), token: getToken(), userId: getUserId() })
  )
}
