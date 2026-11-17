// The calendar shares a user made, as the sharing tools read and write them:
// share_calendar, stop_sharing_calendar and list_calendars. The feed route
// reads the same rows by secret hash (live-deps.ts).
//
// Every query is scoped to the caller's user id, so one user's tools never
// see or touch another user's shares. The role itself could reach every
// user's rows: the scoping is this code's.
//
// A failed query is logged by its SQLSTATE alone and rethrown without its
// message: drizzle's message quotes the query parameters, the user id among
// them, and the tool-call logger would ship it off the box.

import { randomBytes } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'

import { type DatabaseClient } from '@langmail/database'
import { calendar_shares } from '@langmail/database/schema'
import { logger } from '@langmail/logger'

import { hashSecret } from './feed.ts'
import { type ShareLevel } from './render.ts'

export interface CalendarShare {
  // The calendar's CalDAV collection path on Stalwart.
  calendarUrl: string
  id: string
  // Who it is for, as the user named them.
  label: string
  level: ShareLevel
}

export interface CalendarShareStore {
  create: (userId: string, share: Omit<CalendarShare, 'id'> & { secretHash: string }) => Promise<void>
  list: (userId: string) => Promise<CalendarShare[]>
  remove: (userId: string, ids: string[]) => Promise<void>
  setLevel: (userId: string, id: string, level: ShareLevel) => Promise<void>
}

export const toShareLevel = (level: string): ShareLevel => (level === 'full' ? 'full' : 'busy')

// 256 random bits, base64url without padding: the 43 characters feed.ts accepts.
export const mintShareSecret = (): { secret: string; secretHash: string } => {
  const secret = randomBytes(32).toString('base64url')
  return { secret, secretHash: hashSecret(secret) }
}

// The link the person subscribes to, served by the feed route (handler.ts).
export const shareLink = (publicUrl: string, secret: string): string => `${publicUrl}/calendar-feeds/${secret}.ics`

// drizzle wraps the driver's error; the `pg` error with its SQLSTATE is the cause.
const postgresCode = (error: unknown): string | undefined => {
  const cause = error instanceof Error ? error.cause : undefined
  const code = (cause as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

const query = async <T>(op: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    logger.error({ op, pgCode: postgresCode(error) }, 'calendar share query failed')
    throw new Error('the calendar shares could not be read or changed; try again later')
  }
}

const makeStore = (db: DatabaseClient): CalendarShareStore => ({
  create: async (userId, share) => {
    await db.insert(calendar_shares).values({
      calendar_url: share.calendarUrl,
      label: share.label,
      level: share.level,
      secret_hash: share.secretHash,
      user_id: userId,
    })
  },
  list: async (userId) => {
    const rows = await db
      .select({
        calendarUrl: calendar_shares.calendar_url,
        id: calendar_shares.id,
        label: calendar_shares.label,
        level: calendar_shares.level,
      })
      .from(calendar_shares)
      .where(eq(calendar_shares.user_id, userId))
      .orderBy(calendar_shares.created_at)
    return rows.map((row) => ({ ...row, level: toShareLevel(row.level) }))
  },
  remove: async (userId, ids) => {
    if (ids.length === 0) {
      return
    }
    await db.delete(calendar_shares).where(and(eq(calendar_shares.user_id, userId), inArray(calendar_shares.id, ids)))
  },
  setLevel: async (userId, id, level) => {
    await db
      .update(calendar_shares)
      .set({ level })
      .where(and(eq(calendar_shares.user_id, userId), eq(calendar_shares.id, id)))
  },
})

export const makeCalendarShareStore = (db: DatabaseClient): CalendarShareStore => {
  const store = makeStore(db)
  return {
    create: (userId, share) => query('create', () => store.create(userId, share)),
    list: (userId) => query('list', () => store.list(userId)),
    remove: (userId, ids) => query('remove', () => store.remove(userId, ids)),
    setLevel: (userId, id, level) => query('setLevel', () => store.setLevel(userId, id, level)),
  }
}
