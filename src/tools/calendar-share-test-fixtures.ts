// An in-memory calendar share store and sharing deps for the sharing tools'
// unit tests. Rows are built with the database factory, then kept in the
// store's own shape.

import { calendarShareFactory } from '@langmail/database/factories'

import { type CalendarSummary } from '../caldav/types.ts'
import { type CalendarShare, type CalendarShareStore, toShareLevel } from '../calendar-feeds/shares.ts'
import { type CalendarSharingDeps, calendarPath } from './calendar-share-common.ts'

export const USER_ID = 'user-1'
export const PUBLIC_URL = 'https://mcp.example.com'

export const PERSONAL: CalendarSummary = {
  displayName: 'Personal',
  url: 'https://mail.example.com/dav/cal/ana%40example.com/personal/',
}
export const FAMILY: CalendarSummary = {
  displayName: 'Family',
  url: 'https://mail.example.com/dav/cal/ana%40example.com/family/',
}

interface StoredShare extends CalendarShare {
  secretHash: string
  userId: string
}

export interface FakeShareStore extends CalendarShareStore {
  rows: StoredShare[]
}

// A share row as calendar_shares holds it.
export const shareRow = (calendar: CalendarSummary, label: string, level: 'busy' | 'full', userId = USER_ID) => {
  const row = calendarShareFactory.build({
    calendar_url: calendarPath(calendar.url),
    label,
    level,
    user_id: userId,
  })
  return {
    calendarUrl: row.calendar_url,
    id: row.id,
    label: row.label,
    level: toShareLevel(row.level),
    secretHash: row.secret_hash,
    userId: row.user_id,
  }
}

export const fakeShareStore = (rows: StoredShare[] = []): FakeShareStore => {
  const store: FakeShareStore = {
    create: (userId, share) => {
      store.rows.push({ ...share, id: crypto.randomUUID(), userId })
      return Promise.resolve()
    },
    list: (userId) =>
      Promise.resolve(
        store.rows
          .filter((r) => r.userId === userId)
          .map(({ calendarUrl, id, label, level }) => ({ calendarUrl, id, label, level }))
      ),
    remove: (userId, ids) => {
      store.rows = store.rows.filter((r) => !(r.userId === userId && ids.includes(r.id)))
      return Promise.resolve()
    },
    rows,
    setLevel: (userId, id, level) => {
      for (const r of store.rows) {
        if (r.userId === userId && r.id === id) {
          r.level = level
        }
      }
      return Promise.resolve()
    },
  }
  return store
}

export const sharingDeps = (
  shares: CalendarShareStore | undefined,
  calendars: CalendarSummary[] = [PERSONAL, FAMILY]
): CalendarSharingDeps => ({
  listCalendars: () => Promise.resolve(calendars),
  publicUrl: PUBLIC_URL,
  ...(shares ? { shares } : {}),
})

export const ctx = <A>(args: A) => ({ args, token: 'tok', userId: USER_ID })

export const text = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? ''
