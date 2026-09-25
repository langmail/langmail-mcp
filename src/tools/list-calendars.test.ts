import { describe, expect, test } from 'bun:test'

import { type CalendarSummary } from '../caldav/types.ts'
import { listCalendars } from './list-calendars.ts'

const deps = (calendars: CalendarSummary[]) => ({
  listCalendars: () => Promise.resolve(calendars),
})

describe('listCalendars', () => {
  test('formats each calendar with its display name and url', async () => {
    const result = await listCalendars(
      deps([
        { displayName: 'Work', url: 'https://m/dav/cal/u/default/' },
        { displayName: 'Personal', url: 'https://m/dav/cal/u/personal/' },
      ]),
      { token: 'tok' }
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
      { token: 'tok' }
    )
    expect(result.content[0]?.text).toContain('color: #FF6600')
  })

  test('labels an unnamed calendar', async () => {
    const result = await listCalendars(deps([{ displayName: '', url: 'https://m/dav/cal/u/x/' }]), { token: 'tok' })
    expect(result.content[0]?.text).toContain('(unnamed)')
  })

  test("reports 'no calendars' on an empty account", async () => {
    const result = await listCalendars(deps([]), { token: 'tok' })
    expect((result.content[0]?.text ?? '').toLowerCase()).toContain('no calendars')
  })
})
