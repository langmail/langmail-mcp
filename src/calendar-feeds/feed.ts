// GET /calendar-feeds/<secret>.ics: a calendar share's live feed. No bearer —
// the secret in the link is the credential, the same model as the attachment
// capability URLs (docs/adr/0007-attachment-delivery-via-capability-urls.md).
//
// Each fetch looks the share up by the secret's hash, gets the owner's
// Stalwart credential from Auth (the path the workers use), reads the calendar
// over CalDAV and renders it at the share's level.
//
// An unknown or malformed secret, a stopped share, an owner without a mailbox
// and a calendar that is gone all answer the same 200 with an empty calendar:
// an app that gets an error may keep showing the last copy it had. A failure
// upstream (Auth, Stalwart, Postgres) answers 503 instead, so the subscriber
// keeps its last copy rather than seeing the calendar emptied. The secret is in
// no log line and no error report.

import { createHash } from 'node:crypto'

import { parseEvents } from '@langmail/ical'
import { logger } from '@langmail/logger'

import { agendaWindow, windowEntries } from '../caldav/agenda.ts'
import { describeError } from '../observability/errors.ts'
import { renderEmptyFeed, renderFeed, type ShareLevel } from './render.ts'

export interface CalendarShareRecord {
  // The calendar's CalDAV collection path on Stalwart.
  calendarUrl: string
  id: string
  level: ShareLevel
  userId: string
}

export interface OwnerCredential {
  address: string
  // Full Authorization header value for Stalwart (`Basic …`).
  authorization: string
}

export interface FeedCalendar {
  name: string
  // Each stored calendar object's iCalendar data: one event or one series.
  objects: string[]
}

export interface CalendarFeedDeps {
  // The calendar and its events in [start, end), or null when the calendar is gone.
  fetchCalendar: (
    credential: OwnerCredential,
    calendarUrl: string,
    range: { end: Date; start: Date }
  ) => Promise<FeedCalendar | null>
  // Null when the owner has no active mailbox.
  findCredential: (userId: string) => Promise<OwnerCredential | null>
  // Null when the share does not exist.
  findShare: (secretHash: string) => Promise<CalendarShareRecord | null>
  now?: () => Date
}

export type CalendarFeed = (secret: string) => Promise<Response>

// 256 random bits, base64url without padding.
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/u

const PAST_MS = 30 * 86_400_000

export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex')

const calendarResponse = (body: string): Response =>
  new Response(body, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/calendar; charset=utf-8',
      // A capability URL: no referrer leaks it to a link inside the feed.
      'referrer-policy': 'no-referrer',
    },
  })

const emptyFeed = (): Response => calendarResponse(renderEmptyFeed())

// From 30 days back to 12 months ahead.
const feedRange = (now: Date): { end: Date; start: Date } => {
  const end = new Date(now)
  end.setUTCFullYear(end.getUTCFullYear() + 1)
  return { end, start: new Date(now.getTime() - PAST_MS) }
}

// Which upstream a failure came from, for the log line.
type Stage = 'share' | 'credential' | 'calendar'

class FeedUpstreamError extends Error {
  readonly stage: Stage
  constructor(stage: Stage, cause: unknown) {
    super(`calendar feed ${stage} lookup failed`, { cause })
    this.stage = stage
  }
}

const step = async <T>(stage: Stage, run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    throw new FeedUpstreamError(stage, error)
  }
}

const serve = async (deps: CalendarFeedDeps, secret: string): Promise<Response> => {
  const share = await step('share', () => deps.findShare(hashSecret(secret)))
  if (!share) {
    return emptyFeed()
  }
  const credential = await step('credential', () => deps.findCredential(share.userId))
  if (!credential) {
    return emptyFeed()
  }
  const now = deps.now?.() ?? new Date()
  const range = feedRange(now)
  const calendar = await step('calendar', () => deps.fetchCalendar(credential, share.calendarUrl, range))
  if (!calendar) {
    return emptyFeed()
  }
  const window = agendaWindow(range.start.toISOString(), range.end.toISOString())
  // Expanded per stored object, which holds one series with its overrides.
  const entries = calendar.objects.flatMap((data) => windowEntries(parseEvents(data), window))
  return calendarResponse(
    renderFeed({
      entries,
      level: share.level,
      name: calendar.name,
      now,
      ownerAddress: credential.address,
      shareId: share.id,
    })
  )
}

export const createCalendarFeed =
  (deps: CalendarFeedDeps): CalendarFeed =>
  async (secret) => {
    if (!SECRET_RE.test(secret)) {
      return emptyFeed()
    }
    try {
      return await serve(deps, secret)
    } catch (error) {
      // Caught here so the error never reaches Bun's handler or error tracking
      // with the request URL. Only the class and status of the cause go out:
      // a database error's message quotes the query's parameters.
      const cause = error instanceof FeedUpstreamError ? error.cause : error
      const { errorClass, status } = describeError(cause)
      const stage = error instanceof FeedUpstreamError ? error.stage : 'render'
      logger.error({ errorClass, stage, ...(status ? { status } : {}) }, 'calendar feed failed')
      return new Response('calendar temporarily unavailable\n', {
        headers: { 'cache-control': 'no-store', 'retry-after': '300' },
        status: 503,
      })
    }
  }
