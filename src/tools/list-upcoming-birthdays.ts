// list_upcoming_birthdays tool — "whose birthday is coming up", answered from
// the birthdays stored on contact cards across every address book.
//
// The candidate set is fetch-all-and-filter: one unfiltered ContactCard/query
// capped at CARD_CAP ids, one ContactCard/get, then the pure date logic in
// @langmail/contacts on every card. No server-side filter exists for an
// anniversary month, and no index is worth building for address books of the
// size this prototype sees. The cap is stated in the output when it is hit.
//
// TODO: when an account outgrows CARD_CAP, replace the sweep with a
// per-account birthday index refreshed off ContactCard/changes, the way the
// email-agent poller tails Email/changes.
//
// Only *stored* birthdays are listed. Collection never infers one from a
// "happy birthday" subject line, so the field stays authoritative.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  type Birthday,
  bestAddress,
  type CalendarDate,
  daysUntil,
  formatBirthday,
  formatCalendarDate,
  nextOccurrence,
  parseCalendarDate,
  readBirthday,
  todayIn,
} from '@langmail/contacts'
import {
  bearerAuthorization,
  type ContactCard,
  type ContactCardGetParams,
  type ContactCardQueryParams,
} from '@langmail/jmap'

import { type AccountTimeZoneResolver } from '../caldav/account-settings.ts'
import { UTC_TIME_ZONE } from '../caldav/timezone.ts'
import { READ_ONLY } from './annotations.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const listUpcomingBirthdaysShape = {
  days: z
    .number()
    .int()
    .min(1)
    .max(366)
    .default(30)
    .describe(
      'Length of the window in days, counting `from` as day 0: 7 for a week (Monday through Sunday), ' +
        '30 for a month, 90 for a quarter. Defaults to 30.'
    ),
  from: z
    .string()
    .optional()
    .describe(
      'First day of the window as `YYYY-MM-DD`. Defaults to today in the account’s time zone (UTC when none is set) — ' +
        'pass the user’s local date when you know it. A past date answers "which birthdays did I miss last week".'
    ),
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum number of people to list. Defaults to 25.'),
}

export const listUpcomingBirthdaysInput = z.object(listUpcomingBirthdaysShape)

export type ListUpcomingBirthdaysArgs = z.infer<typeof listUpcomingBirthdaysInput>

// The read seam: the write tools' deps bundle plus the account time-zone
// resolver the calendar tools share, so "today" is the user's day.
export interface ListUpcomingBirthdaysDeps {
  contactCardGet: (p: ContactCardGetParams) => Promise<ContactCard[]>
  contactCardQuery: (p: ContactCardQueryParams) => Promise<string[]>
  // Contacts-capability account id for the bearer.
  resolveAccountId: (authorization: string) => Promise<string>
  // The account's preferred zone, or null when none is set (then UTC).
  resolveTimeZone: AccountTimeZoneResolver
}

export interface ListUpcomingBirthdaysContext {
  args: ListUpcomingBirthdaysArgs
  // Injectable for tests; the registration passes the wall clock.
  now?: Date
  token: string
}

// Hard cap on the sweep. Past this, the list may be incomplete and says so.
export const CARD_CAP = 500

interface Upcoming {
  birthday: Birthday
  card: ContactCard
  inDays: number
  occurrence: CalendarDate
}

const whenLine = (inDays: number): string => {
  if (inDays === 0) {
    return 'today'
  }
  return inDays === 1 ? 'tomorrow' : `in ${inDays} days`
}

const nameOf = (card: ContactCard): string => card.name?.full ?? '(unnamed)'

const renderRow = (row: Upcoming, index: number): string => {
  const { birthday, card, inDays, occurrence } = row
  const turning = birthday.year === undefined ? '' : `, turning ${occurrence.year - birthday.year}`
  const best = bestAddress(card, 'any')
  return [
    `${index + 1}. ${nameOf(card)} — ${formatCalendarDate(occurrence)} (${whenLine(inDays)}${turning})`,
    `   contact_id: ${card.id}`,
    `   birthday: ${formatBirthday(birthday)}`,
    // The address to draft a card to, so the next call needs no lookup.
    `   best_address: ${best?.address ?? '(none)'}`,
  ].join('\n')
}

// Today in the account's preferred zone, falling back to UTC — the same
// preference create_calendar_event applies when its input names no zone.
const defaultFrom = async (deps: ListUpcomingBirthdaysDeps, ctx: ListUpcomingBirthdaysContext): Promise<CalendarDate> =>
  todayIn(ctx.now ?? new Date(), (await deps.resolveTimeZone(ctx.token)) ?? UTC_TIME_ZONE)

export const listUpcomingBirthdays = async (
  deps: ListUpcomingBirthdaysDeps,
  ctx: ListUpcomingBirthdaysContext
): Promise<ToolResult> => {
  const { args } = ctx
  const from = args.from === undefined ? await defaultFrom(deps, ctx) : parseCalendarDate(args.from)
  if (!from) {
    return errorResult(`from "${args.from}" is not a calendar date. Use YYYY-MM-DD.`)
  }
  const authorization = bearerAuthorization(ctx.token)
  const accountId = await deps.resolveAccountId(authorization)

  // Every address book, collected and personal alike: update_contact edits
  // any card by id, so a birthday can legitimately live on a collected card.
  const ids = await deps.contactCardQuery({ accountId, apiUrl: '', authorization, limit: CARD_CAP })
  const cards = ids.length > 0 ? await deps.contactCardGet({ accountId, apiUrl: '', authorization, ids }) : []

  const upcoming: Upcoming[] = []
  for (const card of cards) {
    const birthday = readBirthday(card)
    if (!birthday) {
      continue
    }
    const occurrence = nextOccurrence(birthday, from)
    const inDays = daysUntil(occurrence, from)
    // Window end is exclusive: `days: 7` from Monday is Monday through Sunday.
    if (inDays < args.days) {
      upcoming.push({ birthday, card, inDays, occurrence })
    }
  }
  upcoming.sort((a, b) => a.inDays - b.inDays || nameOf(a.card).localeCompare(nameOf(b.card)))

  const window = `the next ${args.days} day(s) from ${formatCalendarDate(from)}`
  const capNote =
    ids.length >= CARD_CAP ? `\n\nThe address book has ${CARD_CAP} cards or more, so this list may be incomplete.` : ''
  if (upcoming.length === 0) {
    return textResult(
      `No birthdays in ${window}. Only birthdays stored on contacts are listed — ` +
        'add one with update_contact if the user knows it.' +
        capNote
    )
  }
  const page = upcoming.slice(0, args.limit)
  const truncationNote =
    upcoming.length > page.length
      ? `\n\nShowing the first ${page.length} of ${upcoming.length} — raise \`limit\` or shorten \`days\` to see the rest.`
      : ''
  return textResult(
    `${upcoming.length} upcoming birthday(s) in ${window}:\n\n${page.map(renderRow).join('\n\n')}${truncationNote}${capNote}`
  )
}

// --- MCP registration ----------------------------------------------------

export const registerListUpcomingBirthdays = (
  server: McpServer,
  deps: ListUpcomingBirthdaysDeps,
  // Bearer threaded per request — see mcp/handler.ts.
  getToken: () => string
): void => {
  server.registerTool(
    'list_upcoming_birthdays',
    {
      annotations: READ_ONLY,
      description:
        'List the contacts whose birthday falls within the next `days` days (7 for a ' +
        'week, 30 for a month, 90 for a quarter), starting from today or from a given ' +
        'date. Use it when the user asks whose birthday is coming up, or which ' +
        'birthdays they missed. Returns each person with the date, how many days away ' +
        'it is, the age they are turning when the birth year is stored, their ' +
        'contact_id and their best email address, so a card can be drafted without ' +
        'another lookup. Every address book is scanned, and only birthdays stored on ' +
        'the contact card are listed — never inferred from mail. A birthday on Feb 29 ' +
        'is listed on Feb 28 in a non-leap year. To look up one person by name, or to ' +
        'set a birthday, use search_contacts and update_contact instead.',
      inputSchema: listUpcomingBirthdaysShape,
      title: 'List upcoming birthdays',
    },
    (args) => {
      const parsed = listUpcomingBirthdaysInput.safeParse(args)
      if (!parsed.success) {
        return Promise.resolve(errorResult(parsed.error.issues.map((i) => i.message).join('; ')))
      }
      return listUpcomingBirthdays(deps, { args: parsed.data, token: getToken() })
    }
  )
}
