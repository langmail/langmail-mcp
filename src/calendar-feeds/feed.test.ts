import { describe, expect, mock, test } from 'bun:test'

import { calendarShareFactory } from '@langmail/database/factories'

import { type CalendarFeedDeps, type CalendarShareRecord, createCalendarFeed, hashSecret } from './feed.ts'

const SECRET = 'A'.repeat(43)
const OBJECT = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:one',
  'DTSTART:20261120T090000Z',
  'DTEND:20261120T100000Z',
  'SUMMARY:Dentist',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const shareRecord = (level: 'busy' | 'full' = 'busy'): CalendarShareRecord => {
  const row = calendarShareFactory.build({ level, secret_hash: hashSecret(SECRET) })
  return { calendarUrl: row.calendar_url, id: row.id, level, userId: row.user_id }
}

const deps = (overrides: Partial<CalendarFeedDeps> = {}): CalendarFeedDeps => ({
  fetchCalendar: () => Promise.resolve({ name: 'Personal', objects: [OBJECT] }),
  findCredential: () => Promise.resolve({ address: 'owner@example.com', authorization: 'Basic x' }),
  findShare: (hash) => Promise.resolve(hash === hashSecret(SECRET) ? shareRecord() : null),
  now: () => new Date('2026-11-13T12:00:00Z'),
  ...overrides,
})

describe('createCalendarFeed', () => {
  test('serves the share at its level as text/calendar', async () => {
    const res = await createCalendarFeed(deps())(SECRET)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    const body = await res.text()
    expect(body).toContain('X-WR-CALNAME:Personal')
    expect(body).toContain('SUMMARY:Busy')
    expect(body).not.toContain('Dentist')
  })

  test('looks the share up by the secret hash and reads 30 days back to 12 months ahead', async () => {
    const findShare = mock(() => Promise.resolve(shareRecord('full')))
    const fetchCalendar = mock(() => Promise.resolve({ name: 'Personal', objects: [OBJECT] }))
    const res = await createCalendarFeed(deps({ fetchCalendar, findShare }))(SECRET)
    expect(await res.text()).toContain('SUMMARY:Dentist')
    expect(findShare).toHaveBeenCalledWith(hashSecret(SECRET))
    const [, , range] = fetchCalendar.mock.calls[0] as unknown as [unknown, unknown, { end: Date; start: Date }]
    expect(range.start.toISOString()).toBe('2026-10-14T12:00:00.000Z')
    expect(range.end.toISOString()).toBe('2027-11-13T12:00:00.000Z')
  })

  test('answers an unknown, malformed or stopped link, a missing mailbox and a gone calendar alike', async () => {
    const unknown = await (await createCalendarFeed(deps())('B'.repeat(43))).text()
    const malformed = await (await createCalendarFeed(deps())('short')).text()
    const noMailbox = await (
      await createCalendarFeed(deps({ findCredential: () => Promise.resolve(null) }))(SECRET)
    ).text()
    const gone = await (await createCalendarFeed(deps({ fetchCalendar: () => Promise.resolve(null) }))(SECRET)).text()
    expect(unknown).not.toContain('BEGIN:VEVENT')
    for (const body of [malformed, noMailbox, gone]) {
      expect(body).toBe(unknown)
    }
  })

  test('answers 503 when an upstream fails, so subscribers keep their copy', async () => {
    const failing = deps({ fetchCalendar: () => Promise.reject(new Error('caldav down')) })
    const res = await createCalendarFeed(failing)(SECRET)
    expect(res.status).toBe(503)
  })
})
