import { describe, expect, test } from 'bun:test'

import { type UpdateCalendarParams } from '../caldav/client.ts'
import { type CalendarSummary } from '../caldav/types.ts'
import { updateCalendar, updateCalendarInput } from './update-calendar.ts'

const WORK: CalendarSummary = { color: '#FF6600', displayName: 'Work', url: 'https://m/dav/cal/u/default/' }
const FAMILY: CalendarSummary = { displayName: 'Family', url: 'https://m/dav/cal/u/family/' }

const makeDeps = (calendars: CalendarSummary[], captured: UpdateCalendarParams[] = []) => ({
  listCalendars: () => Promise.resolve(calendars),
  updateCalendar: (p: UpdateCalendarParams) => {
    captured.push(p)
    return Promise.resolve()
  },
})

const text = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? ''

describe('updateCalendarInput schema', () => {
  test('requires a calendar', () => {
    expect(updateCalendarInput.safeParse({ name: 'Business' }).success).toBe(false)
  })

  test('rejects an empty new name', () => {
    expect(updateCalendarInput.safeParse({ calendar: 'Work', name: '' }).success).toBe(false)
  })

  test('rejects a calendar reference of only spaces, which would match an unnamed calendar', () => {
    expect(updateCalendarInput.safeParse({ calendar: '   ', name: 'Business' }).success).toBe(false)
  })

  test('rejects a new name of only spaces', () => {
    expect(updateCalendarInput.safeParse({ calendar: 'Work', name: '   ' }).success).toBe(false)
  })

  test('stores the new name without surrounding spaces', () => {
    expect(updateCalendarInput.parse({ calendar: 'Work', name: '  Business ' }).name).toBe('Business')
  })

  test('rejects a malformed color', () => {
    expect(updateCalendarInput.safeParse({ calendar: 'Work', color: 'green' }).success).toBe(false)
  })
})

describe('updateCalendar', () => {
  test('renames a calendar picked by its current name', async () => {
    const captured: UpdateCalendarParams[] = []
    const result = await updateCalendar(makeDeps([WORK, FAMILY], captured), {
      args: { calendar: 'Work', name: 'Business' },
      token: 'tok',
    })

    expect(result.isError).toBeUndefined()
    expect(captured).toEqual([{ color: undefined, name: 'Business', token: 'tok', url: WORK.url }])
    expect(text(result)).toContain('"Work" updated: name → "Business"')
    expect(text(result)).toContain(`calendarUrl: ${WORK.url}`)
  })

  test('matches the name ignoring case and surrounding spaces', async () => {
    const captured: UpdateCalendarParams[] = []
    await updateCalendar(makeDeps([WORK, FAMILY], captured), {
      args: { calendar: '  family ', color: '#2E6FD8' },
      token: 'tok',
    })

    expect(captured[0]?.url).toBe(FAMILY.url)
    expect(captured[0]?.color).toBe('#2E6FD8')
  })

  test('picks a calendar by URL, with or without the trailing slash', async () => {
    const captured: UpdateCalendarParams[] = []
    const result = await updateCalendar(makeDeps([WORK, FAMILY], captured), {
      args: { calendar: 'https://m/dav/cal/u/family', color: '#2E6FD8' },
      token: 'tok',
    })

    expect(captured[0]?.url).toBe(FAMILY.url)
    expect(text(result)).toContain('color → #2E6FD8')
  })

  test('matches a URL whether its path is percent-encoded or not, and ignores scheme and host case', async () => {
    const encoded: CalendarSummary = {
      displayName: 'Mine',
      url: 'https://mail.langmail.me/dav/cal/me%40langmail.me/abc/',
    }
    for (const ref of [
      'https://mail.langmail.me/dav/cal/me@langmail.me/abc',
      'http://MAIL.langmail.me/dav/cal/me%40langmail.me/abc/',
      '/dav/cal/me%40langmail.me/abc/',
    ]) {
      const captured: UpdateCalendarParams[] = []
      await updateCalendar(makeDeps([WORK, encoded], captured), { args: { calendar: ref, name: 'Ours' }, token: 'tok' })
      expect(captured[0]?.url).toBe(encoded.url)
    }
  })

  test('on a miss lists every calendar with its URL and changes nothing', async () => {
    const captured: UpdateCalendarParams[] = []
    const result = await updateCalendar(makeDeps([WORK, FAMILY], captured), {
      args: { calendar: 'Langmail', name: 'Business' },
      token: 'tok',
    })

    expect(result.isError).toBe(true)
    expect(captured).toHaveLength(0)
    const msg = text(result)
    expect(msg).toContain('No calendar named "Langmail"')
    expect(msg).toContain('Nothing was changed')
    expect(msg).toContain(`Work — ${WORK.url}`)
    expect(msg).toContain(`Family — ${FAMILY.url}`)
  })

  test('on an unknown URL lists the calendars too', async () => {
    const result = await updateCalendar(makeDeps([WORK]), {
      args: { calendar: 'https://m/dav/cal/u/gone/', name: 'Business' },
      token: 'tok',
    })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('No calendar at https://m/dav/cal/u/gone/')
    expect(text(result)).toContain(`Work — ${WORK.url}`)
  })

  test('asks for the URL when two calendars share the name', async () => {
    const twin: CalendarSummary = { displayName: 'work', url: 'https://m/dav/cal/u/other/' }
    const captured: UpdateCalendarParams[] = []
    const result = await updateCalendar(makeDeps([WORK, twin], captured), {
      args: { calendar: 'Work', name: 'Business' },
      token: 'tok',
    })

    expect(result.isError).toBe(true)
    expect(captured).toHaveLength(0)
    expect(text(result)).toContain('2 calendars are named "Work"')
    expect(text(result)).toContain(WORK.url)
    expect(text(result)).toContain(twin.url)
  })

  test('refuses when neither a new name nor a color is given', async () => {
    const captured: UpdateCalendarParams[] = []
    const result = await updateCalendar(makeDeps([WORK], captured), { args: { calendar: 'Work' }, token: 'tok' })

    expect(result.isError).toBe(true)
    expect(captured).toHaveLength(0)
    expect(text(result)).toContain('Pass name, color, or both')
  })

  test('refuses a new name another calendar already has', async () => {
    const captured: UpdateCalendarParams[] = []
    const result = await updateCalendar(makeDeps([WORK, FAMILY], captured), {
      args: { calendar: 'Work', name: 'family' },
      token: 'tok',
    })

    expect(result.isError).toBe(true)
    expect(captured).toHaveLength(0)
    expect(text(result)).toContain('Another calendar is already named "Family"')
  })

  test('allows renaming a calendar to its own name, so a re-run is harmless', async () => {
    const captured: UpdateCalendarParams[] = []
    const result = await updateCalendar(makeDeps([WORK], captured), {
      args: { calendar: 'Work', name: 'Work' },
      token: 'tok',
    })

    expect(result.isError).toBeUndefined()
    expect(captured).toHaveLength(1)
  })

  test('reports a server refusal as an error naming the calendar', async () => {
    const deps = {
      listCalendars: () => Promise.resolve([WORK]),
      updateCalendar: () => Promise.reject(new Error('caldav PROPPATCH returned 403')),
    }
    const result = await updateCalendar(deps, { args: { calendar: 'Work', name: 'Business' }, token: 'tok' })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Could not update calendar "Work"')
    expect(text(result)).toContain('403')
  })
})
