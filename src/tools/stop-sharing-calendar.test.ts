import { describe, expect, test } from 'bun:test'

import { ctx, FAMILY, fakeShareStore, PERSONAL, shareRow, sharingDeps, text } from './calendar-share-test-fixtures.ts'
import { stopSharingCalendar } from './stop-sharing-calendar.ts'

describe('stopSharingCalendar', () => {
  test("stops the named person's share and keeps everyone else's", async () => {
    const partner = shareRow(FAMILY, 'my partner', 'full')
    const store = fakeShareStore([shareRow(PERSONAL, 'Sam', 'busy'), partner])
    const result = await stopSharingCalendar(sharingDeps(store), ctx({ with: 'sam' }))
    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain('"Personal" with Sam (busy times only)')
    expect(store.rows).toEqual([partner])
  })

  test('without a calendar, every share with that person stops', async () => {
    const store = fakeShareStore([shareRow(PERSONAL, 'Sam', 'busy'), shareRow(FAMILY, 'Sam', 'full')])
    const result = await stopSharingCalendar(sharingDeps(store), ctx({ with: 'Sam' }))
    expect(text(result)).toContain('Stopped 2 share(s)')
    expect(store.rows).toHaveLength(0)
  })

  test('with a calendar, only that share stops', async () => {
    const family = shareRow(FAMILY, 'Sam', 'full')
    const store = fakeShareStore([shareRow(PERSONAL, 'Sam', 'busy'), family])
    await stopSharingCalendar(sharingDeps(store), ctx({ calendar: 'Personal', with: 'Sam' }))
    expect(store.rows).toEqual([family])
  })

  test('another user’s share with the same label is untouched', async () => {
    const theirs = shareRow(PERSONAL, 'Sam', 'busy', 'user-2')
    const store = fakeShareStore([theirs])
    const result = await stopSharingCalendar(sharingDeps(store), ctx({ with: 'Sam' }))
    expect(result.isError).toBe(true)
    expect(store.rows).toEqual([theirs])
  })

  test('a miss stops nothing and lists the current shares', async () => {
    const store = fakeShareStore([shareRow(PERSONAL, 'Sam', 'busy')])
    const result = await stopSharingCalendar(sharingDeps(store), ctx({ with: 'Alex' }))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Nothing was stopped.')
    expect(text(result)).toContain('"Personal" with Sam (busy times only)')
    expect(store.rows).toHaveLength(1)
  })
})
