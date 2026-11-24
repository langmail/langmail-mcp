import { describe, expect, test } from 'bun:test'

import { hashSecret } from '../calendar-feeds/feed.ts'
import { type DraftCreateParams, type EmailSubmissionCreateParams, JmapError } from '../jmap/index.ts'
import {
  ctx,
  FAMILY,
  fakeShareStore,
  PERSONAL,
  PUBLIC_URL,
  sendDeps,
  shareRow,
  sharingDeps,
  text,
  USER_ID,
} from './calendar-share-test-fixtures.ts'
import { gate, settle, TEST_PRINCIPAL } from './draft-test-fixtures.ts'
import { shareCalendar } from './share-calendar.ts'

const LINK_RE = /https:\/\/mcp\.example\.com\/calendar-feeds\/([A-Za-z0-9_-]{43})\.ics/u

describe('shareCalendar', () => {
  test('a new share returns its link, the level, how to add it and the refresh note', async () => {
    const store = fakeShareStore()
    const result = await shareCalendar(
      sharingDeps(store),
      sendDeps(),
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
      await shareCalendar(
        sharingDeps(store),
        sendDeps(),
        ctx({ calendar: 'Personal', level: 'full' as const, with: 'sam' })
      )
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
      await shareCalendar(
        sharingDeps(store),
        sendDeps(),
        ctx({ calendar: 'Personal', level: 'busy' as const, with: 'Sam' })
      )
    )
    expect(store.rows).toEqual([existing])
    expect(answer).toContain('already shared with Sam')
  })

  test('the same person on another calendar is a separate share', async () => {
    const store = fakeShareStore([shareRow(PERSONAL, 'Sam', 'busy')])
    const answer = text(
      await shareCalendar(
        sharingDeps(store),
        sendDeps(),
        ctx({ calendar: 'Family', level: 'full' as const, with: 'Sam' })
      )
    )
    expect(answer).toMatch(LINK_RE)
    expect(store.rows.map((r) => r.level)).toEqual(['busy', 'full'])
  })

  test('a calendar the user does not have creates nothing and lists their calendars', async () => {
    const store = fakeShareStore()
    const result = await shareCalendar(
      sharingDeps(store),
      sendDeps(),
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
      sendDeps(),
      ctx({ calendar: 'Personal', level: 'busy' as const, with: 'Sam' })
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not set up')
  })
})

describe('shareCalendar with an email address', () => {
  const SAM = 'sam@example.com'
  const recorded = () => ({ creates: [] as DraftCreateParams[], submissions: [] as EmailSubmissionCreateParams[] })

  test('shares, emails the link and the steps from the user, and files the copy in Sent', async () => {
    const store = fakeShareStore()
    const rec = recorded()
    const result = await shareCalendar(
      sharingDeps(store),
      sendDeps(rec),
      ctx({ calendar: 'Personal', email: SAM, level: 'full' as const, with: 'Sam' })
    )
    const answer = text(result)
    expect(result.isError).toBeUndefined()
    expect(answer.split('\n')[0]).toContain(`Emailed the link and how to add it to ${SAM}`)
    expect(store.rows).toHaveLength(1)
    expect(rec.creates).toHaveLength(1)
    expect(rec.submissions).toHaveLength(1)
    expect(rec.submissions[0]).toMatchObject({ draftsMailboxId: 'mbDrafts', identityId: 'i1', sentMailboxId: 'mbSent' })
    const draft = rec.creates[0]?.draft
    expect(draft?.from).toEqual([{ email: TEST_PRINCIPAL, name: 'Dana Okonjo' }])
    expect(draft?.to).toEqual([{ email: SAM }])
    expect(draft?.html).toBeUndefined()
    expect(draft?.subject).toBe('Dana Okonjo is sharing the calendar "Personal" with you')
    const secret = LINK_RE.exec(answer)?.[1] ?? ''
    expect(store.rows[0]?.secretHash).toBe(hashSecret(secret))
    const body = draft?.text ?? ''
    expect(body).toStartWith('Dana Okonjo is sharing the calendar "Personal" with you.')
    expect(body).toContain(`${PUBLIC_URL}/calendar-feeds/${secret}.ics`)
    for (const step of ['Other calendars → + → From URL', 'New Calendar Subscription', 'Subscribe from web']) {
      expect(body).toContain(step)
    }
    expect(body).toContain('every few hours, sometimes only once a day')
    expect(body).toContain('do not pass the link on')
    // The email has the steps, so the answer leaves them out.
    expect(answer).not.toContain('How Sam adds it')
  })

  test('in German, with the user’s note above the template', async () => {
    const rec = recorded()
    await shareCalendar(
      sharingDeps(fakeShareStore()),
      sendDeps(rec),
      ctx({
        calendar: 'Family',
        email: 'Alex Partner <alex@example.org>',
        language: 'de' as const,
        level: 'busy' as const,
        note: 'Hallo Alex, hier mein Kalender.',
        with: 'mein Partner',
      })
    )
    const draft = rec.creates[0]?.draft
    expect(draft?.to).toEqual([{ email: 'alex@example.org', name: 'Alex Partner' }])
    expect(draft?.subject).toBe('Dana Okonjo teilt den Kalender „Family“ mit dir')
    const body = draft?.text ?? ''
    expect(body).toStartWith('Hallo Alex, hier mein Kalender.\n\nDana Okonjo teilt den Kalender „Family“ mit dir.')
    expect(body).toContain('wann Dana Okonjo beschäftigt ist')
    for (const step of ['Weitere Kalender → + → Per URL', 'Neues Kalenderabonnement', 'Aus dem Internet abonnieren']) {
      expect(body).toContain(step)
    }
    expect(rec.submissions).toHaveLength(1)
  })

  test('an invalid address shares nothing and sends nothing', async () => {
    const store = fakeShareStore()
    const rec = recorded()
    const result = await shareCalendar(
      sharingDeps(store),
      sendDeps(rec),
      ctx({ calendar: 'Personal', email: 'not an address', level: 'busy' as const, with: 'Sam' })
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Nothing was shared, nothing was sent.')
    expect(store.rows).toHaveLength(0)
    expect(rec.creates).toHaveLength(0)
  })

  test('a note without an address is refused before anything is shared', async () => {
    const store = fakeShareStore()
    const result = await shareCalendar(
      sharingDeps(store),
      sendDeps(),
      ctx({ calendar: 'Personal', level: 'busy' as const, note: 'Hi', with: 'Sam' })
    )
    expect(result.isError).toBe(true)
    expect(store.rows).toHaveLength(0)
  })

  test('without a sending identity or a Drafts folder, nothing is shared', async () => {
    for (const opts of [{ identities: [] }, { mailboxes: { drafts: null, sent: 'mbSent', trash: null } }]) {
      const store = fakeShareStore()
      const rec = { ...recorded(), ...opts }
      const result = await shareCalendar(
        sharingDeps(store),
        sendDeps(rec),
        ctx({ calendar: 'Personal', email: SAM, level: 'busy' as const, with: 'Sam' })
      )
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('Nothing was shared, nothing was sent.')
      expect(store.rows).toHaveLength(0)
      expect(rec.creates).toHaveLength(0)
    }
  })

  test('an existing share changes level and sends nothing', async () => {
    const existing = shareRow(PERSONAL, 'Sam', 'busy')
    const store = fakeShareStore([existing])
    const rec = recorded()
    const answer = text(
      await shareCalendar(
        sharingDeps(store),
        sendDeps(rec),
        ctx({ calendar: 'Personal', email: SAM, level: 'full' as const, with: 'Sam' })
      )
    )
    expect(store.rows).toEqual([{ ...existing, level: 'full' }])
    expect(answer).toContain('existing link keeps working')
    expect(answer).toContain('nothing was emailed')
    expect(answer).toContain('cannot show or send that link again')
    expect(rec.creates).toHaveLength(0)
    expect(rec.submissions).toHaveLength(0)
  })

  test('repeating a call that already sent the email sends no second email', async () => {
    const store = fakeShareStore()
    const rec = recorded()
    const send = sendDeps(rec)
    const args = { calendar: 'Personal', email: SAM, level: 'busy' as const, with: 'Sam' }
    await shareCalendar(sharingDeps(store), send, ctx(args))
    const again = await shareCalendar(sharingDeps(store), send, ctx(args))
    expect(text(again)).toContain('Nothing changed')
    expect(store.rows).toHaveLength(1)
    expect(rec.creates).toHaveLength(1)
    expect(rec.submissions).toHaveLength(1)
  })

  test('two calls at once share and send once', async () => {
    const store = fakeShareStore()
    const rec = recorded()
    const send = sendDeps(rec)
    const held = gate()
    const deps = { ...sharingDeps(store), listCalendars: () => held.passed.then(() => [PERSONAL]) }
    const args = { calendar: 'Personal', email: SAM, level: 'busy' as const, with: 'Sam' }
    const first = shareCalendar(deps, send, ctx(args))
    const second = shareCalendar(deps, send, ctx(args))
    await settle()
    held.open()
    const [a, b] = await Promise.all([first, second])
    expect([a.isError, b.isError].filter(Boolean)).toHaveLength(1)
    expect(store.rows).toHaveLength(1)
    expect(rec.submissions).toHaveLength(1)
  })

  test('a refused send keeps the share, names the draft and gives the link and the steps', async () => {
    const store = fakeShareStore()
    const rec = { ...recorded(), submitError: new JmapError(200, 'forbidden', 'forbiddenFrom') }
    const result = await shareCalendar(
      sharingDeps(store),
      sendDeps(rec),
      ctx({ calendar: 'Personal', email: SAM, level: 'busy' as const, with: 'Sam' })
    )
    const answer = text(result)
    expect(result.isError).toBe(true)
    expect(answer.split('\n')[0]).toContain(`refused to send the email to ${SAM}`)
    expect(answer.split('\n')[0]).toContain('draft dNew1')
    expect(answer).toContain('send_draft')
    expect(answer).toMatch(LINK_RE)
    expect(answer).toContain('How Sam adds it')
    expect(store.rows).toHaveLength(1)
  })

  test('a lost answer says the email may have gone out, keeps the share and gives the link', async () => {
    const store = fakeShareStore()
    const rec = { ...recorded(), submitError: new Error('socket hang up') }
    const result = await shareCalendar(
      sharingDeps(store),
      sendDeps(rec),
      ctx({ calendar: 'Personal', email: SAM, level: 'busy' as const, with: 'Sam' })
    )
    const answer = text(result)
    const first = answer.split('\n')[0] ?? ''
    expect(first).toContain('may already have gone out')
    expect(first).toContain('Do NOT send it again')
    expect(answer).toMatch(LINK_RE)
    expect(answer).toContain('How Sam adds it')
    expect(store.rows).toHaveLength(1)
  })
})
