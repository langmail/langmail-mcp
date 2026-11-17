// The calendar feed's live dependencies: the share table in Postgres, Auth's
// internal credential endpoint and Stalwart's CalDAV.

import { eq } from 'drizzle-orm'

import { type DatabaseClient } from '@langmail/database'
import { calendar_shares } from '@langmail/database/schema'
import { type AuthServiceConfig, fetchStalwartCredential } from '@langmail/jmap'
import { logger } from '@langmail/logger'

import { type CalDavConfig, fetchCalendarList, fetchEvents } from '../caldav/client.ts'
import { sameCalendarUrl } from '../tools/calendar-lookup.ts'
import { type CalendarFeed, type CalendarFeedDeps, type CalendarShareRecord, createCalendarFeed } from './feed.ts'
import { EMPTY_FEED_NAME } from './render.ts'
import { toShareLevel } from './shares.ts'

const findShareBySecretHash =
  (db: DatabaseClient) =>
  async (secretHash: string): Promise<CalendarShareRecord | null> => {
    const [row] = await db
      .select({
        calendarUrl: calendar_shares.calendar_url,
        id: calendar_shares.id,
        level: calendar_shares.level,
        userId: calendar_shares.user_id,
      })
      .from(calendar_shares)
      .where(eq(calendar_shares.secret_hash, secretHash))
      .limit(1)
    return row ? { ...row, level: toShareLevel(row.level) } : null
  }

export interface CalendarFeedLiveConfig {
  authService: AuthServiceConfig
  db: DatabaseClient
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
    findShare: findShareBySecretHash(cfg.db),
  }
}

export interface CalendarFeedEnv {
  // AUTH_INTERNAL_TOKEN, the internal endpoints' shared secret.
  authInternalToken?: string
  // Auth's base URL for /internal/stalwart-credential; defaults to its public URL.
  authServiceUrl: string
  // The server's database client (database.ts), as `mcp_activity`.
  db?: DatabaseClient
  stalwartUrl: string
}

// The feed, or undefined (the route 404s) without a database or the token.
export const calendarFeedFromEnv = (env: CalendarFeedEnv): CalendarFeed | undefined => {
  if (!env.db) {
    // database.ts already warned.
    return
  }
  if (!env.authInternalToken) {
    logger.warn('AUTH_INTERNAL_TOKEN is not set: calendar share feeds are off')
    return
  }
  return createCalendarFeed(
    makeCalendarFeedLiveDeps({
      authService: { baseUrl: env.authServiceUrl, internalToken: env.authInternalToken },
      db: env.db,
      stalwartUrl: env.stalwartUrl,
    })
  )
}
