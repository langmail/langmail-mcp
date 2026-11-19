// The calendar feed's live dependencies: Auth's internal endpoints for the
// share and the owner's Stalwart credential, and Stalwart's CalDAV.

import { postInternal } from '../auth-internal.ts'
import { type CalDavConfig, fetchCalendarList, fetchEvents } from '../caldav/client.ts'
import { type AuthServiceConfig, fetchStalwartCredential } from '../jmap/index.ts'
import { sameCalendarUrl } from '../tools/calendar-lookup.ts'
import { type CalendarFeed, type CalendarFeedDeps, type CalendarShareRecord, createCalendarFeed } from './feed.ts'
import { EMPTY_FEED_NAME } from './render.ts'
import { toShareLevel } from './shares.ts'

export const findShareBySecretHash =
  (auth: AuthServiceConfig) =>
  async (secretHash: string): Promise<CalendarShareRecord | null> => {
    const res = await postInternal(auth, '/internal/calendar-shares/find', { secretHash })
    const { share } = (await res.json()) as { share: CalendarShareRecord | null }
    return share ? { ...share, level: toShareLevel(share.level) } : null
  }

export interface CalendarFeedLiveConfig {
  authService: AuthServiceConfig
  stalwartUrl: string
}

export const makeCalendarFeedLiveDeps = (cfg: CalendarFeedLiveConfig): CalendarFeedDeps => {
  // The credential is the full `Basic …` header Auth hands out.
  const caldav: CalDavConfig = {
    authHeaders: (authorization) => ({ authorization }),
    serverUrl: cfg.stalwartUrl,
  }
  return {
    fetchCalendar: async (credential, calendarUrl, range) => {
      const calendars = await fetchCalendarList(caldav, credential.authorization)
      const calendar = calendars.find((c) => sameCalendarUrl(c.url, calendarUrl))
      if (!calendar) {
        return null
      }
      const objects = await fetchEvents(caldav, {
        calendarUrl: calendar.url,
        timeRange: { end: range.end.toISOString(), start: range.start.toISOString() },
        token: credential.authorization,
      })
      return { name: calendar.displayName || EMPTY_FEED_NAME, objects: objects.map((o) => o.data) }
    },
    findCredential: (userId) => fetchStalwartCredential(userId, cfg.authService),
    findShare: findShareBySecretHash(cfg.authService),
  }
}

// The feed, or undefined (the route 404s) without Auth's internal endpoints
// (auth-internal.ts already logged why).
export const calendarFeedFromEnv = (
  authService: AuthServiceConfig | undefined,
  stalwartUrl: string
): CalendarFeed | undefined =>
  authService ? createCalendarFeed(makeCalendarFeedLiveDeps({ authService, stalwartUrl })) : undefined
