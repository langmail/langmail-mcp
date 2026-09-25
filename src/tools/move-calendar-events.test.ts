import { describe, expect, test } from 'bun:test'

import { type MoveEventOutcome, type MoveEventParams } from '../caldav/client.ts'
import { type CalendarObject, type CalendarSummary } from '../caldav/types.ts'
import {
  MOVE_BUDGET_MS,
  type MoveCalendarEventsArgs,
  type MoveCalendarEventsDeps,
  moveCalendarEvents,
  moveCalendarEventsInput,
} from './move-calendar-events.ts'

const BUSINESS: CalendarSummary = { displayName: 'Business', url: 'https://m/dav/cal/u/default/' }
const PRIVATE: CalendarSummary = { displayName: 'Private', url: 'https://m/dav/cal/u/private/' }
const SHARED: CalendarSummary = { displayName: 'Shared Team', url: 'https://m/dav/cal/u/shared/' }

// One stored object; extra VEVENTs with the same uid stand in for overrides.
const event = (calendar: CalendarSummary, name: string, uid: string, overrides = 0): CalendarObject => {
  const vevent = (extra: string) => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTART:20261006T100000Z',
    'DTEND:20261006T110000Z',
    extra,
    'END:VEVENT',
  ]
  const overrideBlocks = Array.from({ length: overrides }, (_, i) =>
    vevent(`RECURRENCE-ID:2026101${3 + i}T100000Z`)
  ).flat()
  return {
    data: [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      ...vevent(overrides > 0 ? 'RRULE:FREQ=WEEKLY;COUNT=6' : 'SUMMARY:One-off'),
      ...overrideBlocks,
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
    url: `${calendar.url}${name}`,
  }
}

interface Harness {
  deps: MoveCalendarEventsDeps
  listed: string[]
  moves: MoveEventParams[]
}

const makeHarness = (
  contents: Map<CalendarSummary, CalendarObject[]>,
  opts: {
    clock?: () => number
    reply?: (p: MoveEventParams) => Promise<MoveEventOutcome>
  } = {}
): Harness => {
  const listed: string[] = []
  const moves: MoveEventParams[] = []
  return {
    deps: {
      listCalendars: () => Promise.resolve([...contents.keys()]),
      listEvents: (_token, url) => {
        listed.push(url)
        const cal = [...contents.keys()].find((c) => c.url === url)
        return Promise.resolve(cal ? (contents.get(cal) ?? []) : [])
      },
      moveEvent: (p) => {
        moves.push(p)
        return opts.reply ? opts.reply(p) : Promise.resolve({ kind: 'moved' })
      },
      now: opts.clock ?? (() => 0),
    },
    listed,
    moves,
  }
}

const run = (h: Harness, args: Partial<MoveCalendarEventsArgs> & { uids: string[] }) =>
  moveCalendarEvents(h.deps, {
    args: moveCalendarEventsInput.parse({ calendar: 'Private', ...args }),
    token: 'tok',
  })

const text = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? ''

describe('moveCalendarEventsInput schema', () => {
  test('collapses duplicate uids', () => {
    expect(moveCalendarEventsInput.parse({ calendar: 'Private', uids: ['a', 'b', 'a'] }).uids).toEqual(['a', 'b'])
  })

  test('caps the uids as given, before collapsing', () => {
    const uids = Array.from({ length: 51 }, () => 'same')
    expect(moveCalendarEventsInput.safeParse({ calendar: 'Private', uids }).success).toBe(false)
  })

  test('rejects an empty list and a uid with a path separator', () => {
    expect(moveCalendarEventsInput.safeParse({ calendar: 'Private', uids: [] }).success).toBe(false)
    expect(moveCalendarEventsInput.safeParse({ calendar: 'Private', uids: ['../x'] }).success).toBe(false)
  })

  test('rejects a destination of only spaces', () => {
    expect(moveCalendarEventsInput.safeParse({ calendar: '  ', uids: ['a'] }).success).toBe(false)
  })
})

describe('moveCalendarEvents', () => {
  test('moves each event with a MOVE to the destination, keeping its resource name verbatim', async () => {
    const h = makeHarness(
      new Map([
        [BUSINESS, [event(BUSINESS, 'yoga.ics', 'yoga', 2), event(BUSINESS, 'probe@example.com.ics', 'physio')]],
        [PRIVATE, []],
      ])
    )
    const result = await run(h, { uids: ['yoga', 'physio'] })

    expect(result.isError).toBeUndefined()
    expect(text(result)).toBe('Moved 2 event(s) to Private.')
    expect(h.moves).toEqual([
      { destination: `${PRIVATE.url}yoga.ics`, token: 'tok', url: `${BUSINESS.url}yoga.ics` },
      {
        destination: `${PRIVATE.url}probe@example.com.ics`,
        token: 'tok',
        url: `${BUSINESS.url}probe@example.com.ics`,
      },
    ])
  })

  test('does not re-encode a percent-encoded resource name', async () => {
    const h = makeHarness(
      new Map([
        [BUSINESS, [event(BUSINESS, 'termin-%C3%A4rztin.ics', 'doc')]],
        [PRIVATE, []],
      ])
    )
    await run(h, { uids: ['doc'] })
    expect(h.moves[0]?.destination).toBe(`${PRIVATE.url}termin-%C3%A4rztin.ics`)
  })

  test('lists each calendar once, however many uids are asked for', async () => {
    const h = makeHarness(
      new Map([
        [BUSINESS, [event(BUSINESS, 'a.ics', 'a'), event(BUSINESS, 'b.ics', 'b')]],
        [PRIVATE, []],
        [SHARED, [event(SHARED, 'c.ics', 'c')]],
      ])
    )
    await run(h, { uids: ['a', 'b', 'c'] })
    expect(h.listed.toSorted()).toEqual([BUSINESS.url, PRIVATE.url, SHARED.url].toSorted())
    expect(h.moves).toHaveLength(3)
  })

  test('resolves the destination by name ignoring case, or by URL', async () => {
    const byName = makeHarness(
      new Map([
        [BUSINESS, [event(BUSINESS, 'a.ics', 'a')]],
        [PRIVATE, []],
      ])
    )
    await run(byName, { calendar: '  private ', uids: ['a'] })
    expect(byName.moves[0]?.destination).toBe(`${PRIVATE.url}a.ics`)

    const byUrl = makeHarness(
      new Map([
        [BUSINESS, [event(BUSINESS, 'a.ics', 'a')]],
        [PRIVATE, []],
      ])
    )
    await run(byUrl, { calendar: 'https://m/dav/cal/u/private', uids: ['a'] })
    expect(byUrl.moves[0]?.destination).toBe(`${PRIVATE.url}a.ics`)
  })

  test('an unknown destination lists every calendar with its URL and moves nothing', async () => {
    const h = makeHarness(
      new Map([
        [BUSINESS, [event(BUSINESS, 'a.ics', 'a')]],
        [PRIVATE, []],
      ])
    )
    const result = await run(h, { calendar: 'Family', uids: ['a'] })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('No calendar named "Family". Nothing was moved.')
    expect(text(result)).toContain(`Business — ${BUSINESS.url}`)
    expect(text(result)).toContain('as calendar')
    expect(h.moves).toEqual([])
  })

  test('an event already in the destination counts as done, and a copy elsewhere is named', async () => {
    const h = makeHarness(
      new Map([
        [BUSINESS, [event(BUSINESS, 'dup.ics', 'dup')]],
        [PRIVATE, [event(PRIVATE, 'done.ics', 'done'), event(PRIVATE, 'dup.ics', 'dup')]],
      ])
    )
    const result = await run(h, { uids: ['done', 'dup'] })

    expect(result.isError).toBeUndefined()
    expect(text(result)).toBe(
      'Moved 0 event(s) to Private.\n' +
        'Already in Private (2): done, dup (a copy with this uid is also in "Business").'
    )
    expect(h.moves).toEqual([])
  })

  test('already-there wins over fromCalendar, so a repeated call finds its work done', async () => {
    const h = makeHarness(
      new Map([
        [BUSINESS, []],
        [PRIVATE, [event(PRIVATE, 'x.ics', 'x')]],
      ])
    )
    const result = await run(h, { fromCalendar: 'Business', uids: ['x'] })
    expect(text(result)).toContain('Already in Private (1): x.')
    expect(result.isError).toBeUndefined()
  })

  test('a uid in two source calendars is ambiguous until fromCalendar picks one', async () => {
    const contents = new Map([
      [BUSINESS, [event(BUSINESS, 'inv.ics', 'inv')]],
      [PRIVATE, []],
      [SHARED, [event(SHARED, 'inv-copy.ics', 'inv')]],
    ])
    const h = makeHarness(contents)
    const result = await run(h, { uids: ['inv'] })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain(
      `Not moved (1): inv (ambiguous: in "Business" <${BUSINESS.url}> and "Shared Team" <${SHARED.url}>; ` +
        'pass one as fromCalendar).'
    )
    expect(h.moves).toEqual([])

    const picked = makeHarness(contents)
    await run(picked, { fromCalendar: 'Shared Team', uids: ['inv'] })
    expect(picked.moves).toEqual([
      { destination: `${PRIVATE.url}inv-copy.ics`, token: 'tok', url: `${SHARED.url}inv-copy.ics` },
    ])
    expect(picked.listed.toSorted()).toEqual([PRIVATE.url, SHARED.url].toSorted())
  })

  test('a missing uid is reported as notFound while the rest still move', async () => {
    const h = makeHarness(
      new Map([
        [BUSINESS, [event(BUSINESS, 'a.ics', 'a')]],
        [PRIVATE, []],
      ])
    )
    const result = await run(h, { uids: ['a', 'ghost'] })

    expect(result.isError).toBeUndefined()
    expect(text(result)).toBe(
      'Moved 1 event(s) to Private.\n' +
        'Not moved (1): ghost (notFound: in none of your calendars; check the uid with list_calendar_events).'
    )
  })

  test('refuses a fromCalendar that is the destination', async () => {
    const h = makeHarness(
      new Map([
        [BUSINESS, []],
        [PRIVATE, []],
      ])
    )
    const result = await run(h, { fromCalendar: 'private', uids: ['a'] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Nothing was moved.')
    expect(h.listed).toEqual([])
  })

  test('an unknown fromCalendar names the argument to fix', async () => {
    const h = makeHarness(
      new Map([
        [BUSINESS, []],
        [PRIVATE, []],
      ])
    )
    const result = await run(h, { fromCalendar: 'Work', uids: ['a'] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('No calendar named "Work". Nothing was moved.')
    expect(text(result)).toContain('as fromCalendar')
  })

  test('maps every server refusal to its own reason, and none of them is a success', async () => {
    const replies: Record<string, MoveEventOutcome> = {
      'a.ics': { kind: 'uidConflict' },
      'b.ics': { kind: 'nameConflict' },
      'c.ics': { kind: 'forbidden' },
      'd.ics': { kind: 'failed', status: 500 },
    }
    const h = makeHarness(
      new Map([
        [BUSINESS, ['a', 'b', 'c', 'd'].map((u) => event(BUSINESS, `${u}.ics`, u))],
        [PRIVATE, []],
      ]),
      { reply: (p) => Promise.resolve(replies[p.url.slice(p.url.lastIndexOf('/') + 1)] ?? { kind: 'moved' }) }
    )
    const result = await run(h, { uids: ['a', 'b', 'c', 'd'] })
    const body = text(result)

    expect(result.isError).toBe(true)
    expect(body).toContain('a (uidConflict: "Private" already holds a separate copy of this event;')
    expect(body).toContain('b (nameConflict:')
    expect(body).toContain('c (forbidden:')
    expect(body).toContain('d (failed: the server answered HTTP 500; re-run to retry)')
  })

  test('a MOVE that breaks off is reported as an unknown outcome, not as an error', async () => {
    for (const err of [
      Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }),
      new Error('The socket connection was closed unexpectedly.'),
    ]) {
      const h = makeHarness(
        new Map([
          [BUSINESS, [event(BUSINESS, 'a.ics', 'a')]],
          [PRIVATE, []],
        ]),
        {
          reply: () => Promise.reject(err),
        }
      )
      const result = await run(h, { uids: ['a'] })
      expect(text(result)).toContain('Outcome unknown (1): a')
      expect(text(result)).toContain('may have moved')
      expect(result.isError).toBeUndefined()
    }
  })

  test('a call where every uid is missing is an error', async () => {
    const h = makeHarness(
      new Map([
        [BUSINESS, []],
        [PRIVATE, []],
      ])
    )
    const result = await run(h, { uids: ['ghost'] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('ghost (notFound:')
  })

  test('an unreadable source calendar does not block moves out of the others', async () => {
    const h = makeHarness(
      new Map([
        [BUSINESS, [event(BUSINESS, 'a.ics', 'a')]],
        [PRIVATE, []],
        [SHARED, []],
      ])
    )
    const listEvents = h.deps.listEvents
    h.deps.listEvents = (token, url) => (url === SHARED.url ? Promise.reject(new Error('503')) : listEvents(token, url))
    const result = await run(h, { uids: ['a', 'b'] })

    expect(result.isError).toBeUndefined()
    expect(h.moves).toHaveLength(1)
    expect(text(result)).toContain('Moved 1 event(s) to Private.')
    expect(text(result)).toContain('b (notFound:')
    expect(text(result)).toContain('Could not read "Shared Team"')
  })

  test('an unreadable destination moves nothing', async () => {
    const h = makeHarness(
      new Map([
        [BUSINESS, [event(BUSINESS, 'a.ics', 'a')]],
        [PRIVATE, []],
      ])
    )
    const listEvents = h.deps.listEvents
    h.deps.listEvents = (token, url) =>
      url === PRIVATE.url ? Promise.reject(new Error('503')) : listEvents(token, url)
    const result = await run(h, { uids: ['a'] })

    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Could not read "Private": 503. Nothing was moved. Re-run later.')
    expect(h.moves).toEqual([])
  })

  test('stops starting moves once the time budget is spent and names the rest', async () => {
    let clock = 0
    const h = makeHarness(
      new Map([
        [BUSINESS, ['a', 'b', 'c'].map((u) => event(BUSINESS, `${u}.ics`, u))],
        [PRIVATE, []],
      ]),
      {
        clock: () => clock,
        reply: () => {
          clock += MOVE_BUDGET_MS
          return Promise.resolve({ kind: 'moved' })
        },
      }
    )
    const result = await run(h, { uids: ['a', 'b', 'c'] })

    expect(result.isError).toBeUndefined()
    expect(h.moves).toHaveLength(1)
    expect(text(result)).toBe(
      'Moved 1 event(s) to Private.\nNot attempted (2): b, c — out of time. Re-run with these uids.'
    )
  })
})
