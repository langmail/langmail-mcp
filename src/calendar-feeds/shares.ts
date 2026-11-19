// The calendar shares a user made, as the sharing tools read and write them:
// share_calendar, stop_sharing_calendar and list_calendars. The feed route
// reads the same rows by secret hash (live-deps.ts).
//
// The rows live in Langmail's database, which Auth reads and writes for this
// server over its internal endpoints (auth-internal.ts). Every call carries
// the caller's user id, and Auth scopes it to that user's rows, so one user's
// tools never see or touch another user's shares.
//
// A failed call is logged by its operation and status alone and rethrown
// as one message the tools show.

import { randomBytes } from 'node:crypto'

import { type AuthServiceConfig } from '@langmail/jmap'
import { logger } from '@langmail/logger'

import { InternalAuthError, postInternal } from '../auth-internal.ts'
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

const SHARES_PATH = '/internal/calendar-shares'

const call = async <T>(op: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    logger.error(
      { op, status: error instanceof InternalAuthError ? error.status : undefined },
      'calendar share call failed'
    )
    throw new Error('the calendar shares could not be read or changed; try again later')
  }
}

export const makeCalendarShareStore = (auth: AuthServiceConfig): CalendarShareStore => {
  const post = (op: string, body: unknown) => postInternal(auth, `${SHARES_PATH}/${op}`, body)
  return {
    create: (userId, share) =>
      call('create', async () => {
        await post('create', { ...share, userId })
      }),
    list: (userId) =>
      call('list', async () => {
        const { shares } = (await (await post('list', { userId })).json()) as { shares: CalendarShare[] }
        return shares.map((share) => ({ ...share, level: toShareLevel(share.level) }))
      }),
    remove: (userId, ids) =>
      call('remove', async () => {
        if (ids.length > 0) {
          await post('remove', { ids, userId })
        }
      }),
    setLevel: (userId, id, level) =>
      call('setLevel', async () => {
        await post('set-level', { id, level, userId })
      }),
  }
}
