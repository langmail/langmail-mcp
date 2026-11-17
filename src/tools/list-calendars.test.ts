import { describe, expect, test } from 'bun:test'

import { type CalendarSummary } from '../caldav/types.ts'
import { FAMILY, fakeShareStore, PERSONAL, shareRow, sharingDeps } from './calendar-share-test-fixtures.ts'
import { listCalendars } from './list-calendars.ts'

const deps = (calendars: CalendarSummary[]) => sharingDeps(undefined, calendars)

describe('listCalendars', () => {
  test('formats each calendar with its display name and url', async () => {
    const result = await listCalendars(
      deps([
        { displayName: 'Work', url: 'https://m/dav/cal/u/default/' },
        { displayName: 'Personal', url: 'https://m/dav/cal/u/personal/' },
      ]),
      { token: 'tok', userId: 'user-1' }
    )
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('2 calendar(s)')
    expect(txt).toContain('Work')
    expect(txt).toContain('https://m/dav/cal/u/default/')
    expect(txt).toContain('Personal')
  })

  test('shows a calendar color when the server has one', async () => {
    const result = await listCalendars(
      deps([{ color: '#FF6600', displayName: 'Work', url: 'https://m/dav/cal/u/default/' }]),
      { token: 'tok', userId: 'user-1' }
    )
    expect(result.content[0]?.text).toContain('color: #FF6600')
  })

  test('labels an unnamed calendar', async () => {
    const result = await listCalendars(deps([{ displayName: '', url: 'https://m/dav/cal/u/x/' }]), {
      token: 'tok',
      userId: 'user-1',
    })
    expect(result.content[0]?.text).toContain('(unnamed)')
  })

  test("reports 'no calendars' on an empty account", async () => {
    const result = await listCalendars(deps([]), { token: 'tok', userId: 'user-1' })
    expect((result.content[0]?.text ?? '').toLowerCase()).toContain('no calendars')
  })

  test('names every person each calendar is shared with, at which level, and the calendars not shared', async () => {
    const store = fakeShareStore([
      shareRow(PERSONAL, 'Sam', 'busy'),
      shareRow(PERSONAL, 'Alex', 'full'),
      shareRow(FAMILY, 'Kim', 'full', 'user-2'),
    ])
    const result = await listCalendars(sharingDeps(store), { token: 'tok', userId: 'user-1' })
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain(
      `Personal\n   url: ${PERSONAL.url}\n   shared with: Sam (busy times only), Alex (full details)`
    )
    expect(txt).toContain(`Family\n   url: ${FAMILY.url}\n   not shared`)
    expect(txt).not.toContain('Kim')
  })

  test('lists the calendars when the shares fail to load', async () => {
    const store = fakeShareStore()
    store.list = () => Promise.reject(new Error('down'))
    const result = await listCalendars(sharingDeps(store), { token: 'tok', userId: 'user-1' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('Personal')
    expect(result.content[0]?.text).toContain('sharing: unknown')
  })
})
