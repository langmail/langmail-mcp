import { describe, expect, test } from 'bun:test'

import { hashSecret } from '../calendar-feeds/feed.ts'
import {
  ctx,
  FAMILY,
  fakeShareStore,
  PERSONAL,
  PUBLIC_URL,
  shareRow,
  sharingDeps,
  text,
  USER_ID,
} from './calendar-share-test-fixtures.ts'
import { shareCalendar } from './share-calendar.ts'

const LINK_RE = /https:\/\/mcp\.example\.com\/calendar-feeds\/([A-Za-z0-9_-]{43})\.ics/u

describe('shareCalendar', () => {
  test('a new share returns its link, the level, how to add it and the refresh note', async () => {
    const store = fakeShareStore()
    const result = await shareCalendar(
      sharingDeps(store),
      ctx({ calendar: 'personal', level: 'busy' as const, with: 'Sam' })
    )
    const answer = text(result)
    expect(result.isError).toBeUndefined()
    const secret = LINK_RE.exec(answer)?.[1]
    expect(answer).toStartWith(`Shared "Personal" with Sam at busy times only`)
    expect(answer).toContain(PUBLIC_URL)
    for (const app of ['Google Calendar', 'Apple Calendar', 'Outlook']) {
      expect(answer).toContain(app)
    }
    expect(answer).toContain('every few hours, sometimes only once a day')
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0]).toMatchObject({
      calendarUrl: '/dav/cal/ana%40example.com/personal/',
      label: 'Sam',
      level: 'busy',
      secretHash: hashSecret(secret ?? ''),
      userId: USER_ID,
    })
  })

  test('sharing again at the other level changes the level and keeps the link', async () => {
    const existing = shareRow(PERSONAL, 'Sam', 'busy')
    const store = fakeShareStore([existing])
    const answer = text(
      await shareCalendar(sharingDeps(store), ctx({ calendar: 'Personal', level: 'full' as const, with: 'sam' }))
    )
    expect(store.rows).toEqual([{ ...existing, level: 'full' }])
    expect(answer).toContain('now shared with Sam at full details')
    expect(answer).toContain('existing link keeps working')
    expect(answer).not.toMatch(LINK_RE)
  })

  test('sharing again at the same level changes nothing', async () => {
    const existing = shareRow(PERSONAL, 'Sam', 'busy')
    const store = fakeShareStore([existing])
    const answer = text(
      await shareCalendar(sharingDeps(store), ctx({ calendar: 'Personal', level: 'busy' as const, with: 'Sam' }))
    )
    expect(store.rows).toEqual([existing])
    expect(answer).toContain('already shared with Sam')
  })

  test('the same person on another calendar is a separate share', async () => {
    const store = fakeShareStore([shareRow(PERSONAL, 'Sam', 'busy')])
    const answer = text(
      await shareCalendar(sharingDeps(store), ctx({ calendar: 'Family', level: 'full' as const, with: 'Sam' }))
    )
    expect(answer).toMatch(LINK_RE)
    expect(store.rows.map((r) => r.level)).toEqual(['busy', 'full'])
  })

  test('a calendar the user does not have creates nothing and lists their calendars', async () => {
    const store = fakeShareStore()
    const result = await shareCalendar(
      sharingDeps(store),
      ctx({ calendar: 'Work', level: 'busy' as const, with: 'Sam' })
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Nothing was shared.')
    expect(text(result)).toContain(PERSONAL.url)
    expect(text(result)).toContain(FAMILY.url)
    expect(store.rows).toHaveLength(0)
  })

  test('without a database, sharing is off', async () => {
    const result = await shareCalendar(
      sharingDeps(undefined),
      ctx({ calendar: 'Personal', level: 'busy' as const, with: 'Sam' })
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not set up')
  })
})
