// What share_calendar, stop_sharing_calendar and list_calendars share: the
// deps, how a level reads to the user, and how a person's share is matched.
// The shares themselves live in calendar-feeds/shares.ts.

import { type CalDavConfig, fetchCalendarList } from '../caldav/client.ts'
import { type CalendarSummary } from '../caldav/types.ts'
import { type ShareLevel } from '../calendar-feeds/render.ts'
import { type CalendarShare, type CalendarShareStore } from '../calendar-feeds/shares.ts'
import { calendarLabel, sameCalendarUrl } from './calendar-lookup.ts'

export interface CalendarSharingDeps {
  listCalendars: (token: string) => Promise<CalendarSummary[]>
  // Base URL the share links are minted under (the feed route's host).
  publicUrl: string
  // Undefined without Auth's internal endpoints: sharing is off.
  shares?: CalendarShareStore
}

export interface CalendarSharingContext {
  token: string
  userId: string
}

export const SHARING_OFF = 'Calendar sharing is not set up on this server.'

export const levelWords = (level: ShareLevel): string => (level === 'busy' ? 'busy times only' : 'full details')

// "Sam" and "sam" are the same person on one calendar.
export const sameLabel = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

// What a share's calendar_url stores: the collection's path as CalDAV gives
// it, which the feed matches against the live calendar list with
// sameCalendarUrl (that decodes both sides).
export const calendarPath = (url: string): string => new URL(url, 'https://calendar.invalid').pathname

export const sharesOn = (shares: CalendarShare[], calendar: CalendarSummary): CalendarShare[] =>
  shares.filter((s) => sameCalendarUrl(s.calendarUrl, calendar.url))

const shareCalendarName = (share: CalendarShare, calendars: CalendarSummary[]): string => {
  const calendar = calendars.find((c) => sameCalendarUrl(share.calendarUrl, c.url))
  return calendar ? `"${calendarLabel(calendar)}"` : 'a calendar that no longer exists'
}

export const describeShare = (share: CalendarShare, calendars: CalendarSummary[]): string =>
  `${shareCalendarName(share, calendars)} with ${share.label} (${levelWords(share.level)})`

// Every share, one per line, for an answer that has to name them.
export const shareLines = (shares: CalendarShare[], calendars: CalendarSummary[]): string =>
  shares.length === 0
    ? 'None of your calendars is shared.'
    : `Your calendar shares:\n${shares.map((s) => `- ${describeShare(s, calendars)}`).join('\n')}`

export const makeLiveCalendarSharingDeps = (
  cfg: CalDavConfig,
  publicUrl: string,
  shares: CalendarShareStore | undefined
): CalendarSharingDeps => ({
  listCalendars: (token) => fetchCalendarList(cfg, token),
  publicUrl,
  ...(shares ? { shares } : {}),
})
