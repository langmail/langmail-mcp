// An in-memory calendar share store and sharing deps for the sharing tools'
// unit tests, with rows in the store's own shape. The server has no database
// package, so rows are built here rather than with its factories.

import { randomBytes } from 'node:crypto'

import { type CalendarSummary } from '../caldav/types.ts'
import { type CalendarShare, type CalendarShareStore } from '../calendar-feeds/shares.ts'
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

export interface StoredShare extends CalendarShare {
  secretHash: string
  userId: string
}

export interface FakeShareStore extends CalendarShareStore {
  rows: StoredShare[]
}

// A share row as Auth holds it.
export const shareRow = (
  calendar: CalendarSummary,
  label: string,
  level: 'busy' | 'full',
  userId = USER_ID
): StoredShare => ({
  calendarUrl: calendarPath(calendar.url),
  id: crypto.randomUUID(),
  label,
  level,
  secretHash: randomBytes(32).toString('hex'),
  userId,
})

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
