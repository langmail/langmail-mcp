// Integration tests for the CalDAV adapter against a *real* server.
//
// Our unit tests mock the tool `Deps`, so the tsdav-backed client in
// client.ts — REPORT/multiget, PUT/DELETE, URL + filename handling — is
// never exercised. That's exactly where the "delete 404s" bug lived: we
// assumed the stored object is named `${uid}.ics`. These tests drive the
// live client against Radicale (started in CI) over Basic auth, including
// the filename≠UID regression.
//
// They skip unless CALDAV_BASE_URL / _USERNAME / _PASSWORD are set, so the
// normal `bun test` run stays hermetic. CI sets them; see the caldav job in
// .github/workflows/test.yml. Run locally with:
//   CALDAV_BASE_URL=http://127.0.0.1:5232 CALDAV_USERNAME=test \
//   CALDAV_PASSWORD=test bun test caldav-integration

import { beforeAll, describe, expect, test } from 'bun:test'
import { createCalendarObject } from 'tsdav'

import { deleteCalendarEvent, makeLiveDeps as makeDeleteDeps } from '../tools/delete-calendar-event.ts'
import { listCalendarEvents, makeLiveDeps as makeListDeps } from '../tools/list-calendar-events.ts'
import { makeLiveDeps as makeRespondDeps, respondToEvent } from '../tools/respond-to-event.ts'
import type { CalDavConfig } from './client.ts'
import {
  createCalendar,
  deleteEvent,
  fetchCalendarList,
  fetchEvent,
  fetchEvents,
  putEvent,
  updateEvent,
  withTrailingSlash,
} from './client.ts'
import { buildInvite } from './ical.ts'

const BASE = process.env.CALDAV_BASE_URL
const USER = process.env.CALDAV_USERNAME
const PASS = process.env.CALDAV_PASSWORD

// The credential threaded through the client is ignored by Basic auth; the
// header comes from cfg.authHeaders. Use a marker so a stray Bearer is obvious.
const TOKEN = 'integration-basic-auth'

const live = BASE && USER && PASS ? describe : describe.skip

live('caldav client against a live server', () => {
  const base = BASE as string
  const user = USER as string
  const basic = `Basic ${btoa(`${user}:${PASS as string}`)}`
  const cfg: CalDavConfig = { authHeaders: () => ({ authorization: basic }), serverUrl: base }
  const calendarUrl = withTrailingSlash(`${base}/${user}/mcp-it`)

  const invite = (uid: string, title: string, rrule?: string): string =>
    buildInvite({
      attendees: ['guest@example.com'],
      end: new Date('2026-06-12T10:30:00Z'),
      organizer: `${user}@example.com`,
      start: new Date('2026-06-12T10:00:00Z'),
      title,
      uid,
      ...(rrule ? { rrule } : {}),
    })

  beforeAll(async () => {
    // Provision the calendar collection. 201 = created; 405/409 = already
    // exists (idempotent). Anything else is a real setup failure (bad URL or
    // auth) worth surfacing here rather than as confusing 404s in every test.
    const res = await fetch(calendarUrl, { headers: { authorization: basic }, method: 'MKCALENDAR' })
    if (!res.ok && res.status !== 405 && res.status !== 409) {
      throw new Error(`MKCALENDAR ${calendarUrl} failed: ${res.status}`)
    }
  })

  test('create → fetch → update → delete round-trips', async () => {
    const uid = `lifecycle-${Date.now()}@mcp-it`
    await putEvent(cfg, { calendarUrl, ical: invite(uid, 'Original'), token: TOKEN, uid })

    const created = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expect(created).not.toBeNull()
    expect(created?.data).toContain('SUMMARY:Original')

    await updateEvent(cfg, {
      ical: invite(uid, 'Updated'),
      token: TOKEN,
      url: created?.url ?? '',
      ...(created?.etag ? { etag: created.etag } : {}),
    })

    const updated = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expect(updated?.data).toContain('SUMMARY:Updated')

    await deleteEvent(cfg, {
      token: TOKEN,
      url: updated?.url ?? '',
      ...(updated?.etag ? { etag: updated.etag } : {}),
    })
    expect(await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })).toBeNull()
  })

  // Recurrence (RRULE) round-trip against the real server: a recurring VEVENT
  // must survive the PUT, come back with its RRULE intact, surface as `repeats:`
  // through the list tool, and re-rule cleanly on update. Unit tests only prove
  // we *emit* the RRULE — this proves Radicale stores and returns it unmangled.
  test('recurring event round-trips its RRULE through create → list → update → delete', async () => {
    const uid = `recurring-${Date.now()}@mcp-it`
    await putEvent(cfg, { calendarUrl, ical: invite(uid, 'Weekly sync', 'FREQ=WEEKLY;BYDAY=TH'), token: TOKEN, uid })

    const created = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expect(created?.data).toContain('RRULE:FREQ=WEEKLY;BYDAY=TH')

    // The list tool parses the stored RRULE back out and renders it as `repeats:`.
    const list = await listCalendarEvents(makeListDeps(cfg), { args: { calendarUrl }, token: TOKEN })
    expect(list.content[0]?.text).toContain('repeats: FREQ=WEEKLY;BYDAY=TH')

    // Re-rule the whole series (here: weekdays, bounded by COUNT). The new rule
    // must replace the old one, not accumulate a second RRULE line.
    await updateEvent(cfg, {
      ical: invite(uid, 'Weekly sync', 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=12'),
      token: TOKEN,
      url: created?.url ?? '',
      ...(created?.etag ? { etag: created.etag } : {}),
    })

    const updated = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expect(updated?.data).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=12')
    expect(updated?.data).not.toContain('FREQ=WEEKLY;BYDAY=TH')

    await deleteEvent(cfg, {
      token: TOKEN,
      url: updated?.url ?? '',
      ...(updated?.etag ? { etag: updated.etag } : {}),
    })
    expect(await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })).toBeNull()
  })

  test('finds and deletes an event whose filename differs from its UID (regression)', async () => {
    const uid = `mismatch-${Date.now()}@mcp-it`
    // Store under a server-style name unrelated to the UID — the exact shape
    // that used to 404 because the client guessed `${uid}.ics`.
    const filename = `server-named-${Date.now()}.ics`
    await createCalendarObject({
      calendar: { url: calendarUrl },
      filename,
      headers: { authorization: basic },
      iCalString: invite(uid, 'Mismatch'),
    })

    const found = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expect(found).not.toBeNull()
    // Matched on the parsed UID, not the filename: the real href is the
    // server-chosen name, which bears no relation to the UID.
    expect(found?.url).toContain(filename)

    await deleteEvent(cfg, {
      token: TOKEN,
      url: found?.url ?? '',
      ...(found?.etag ? { etag: found.etag } : {}),
    })
    expect(await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })).toBeNull()
  })

  test('fetchEvents lists every stored event regardless of filename', async () => {
    const a = `multi-a-${Date.now()}@mcp-it`
    const b = `multi-b-${Date.now()}@mcp-it`
    await putEvent(cfg, { calendarUrl, ical: invite(a, 'A'), token: TOKEN, uid: a })
    await createCalendarObject({
      calendar: { url: calendarUrl },
      filename: `b-${Date.now()}.ics`,
      headers: { authorization: basic },
      iCalString: invite(b, 'B'),
    })

    const data = (await fetchEvents(cfg, { calendarUrl, token: TOKEN })).map((o) => o.data).join('\n')
    expect(data).toContain(a)
    expect(data).toContain(b)

    for (const uid of [a, b]) {
      const obj = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
      await deleteEvent(cfg, { token: TOKEN, url: obj?.url ?? '', ...(obj?.etag ? { etag: obj.etag } : {}) })
    }
  })

  // End-to-end through the actual MCP tools (discover → resolve → collection
  // query → parse/format) — the same "Collection query" path that 404s when
  // the live server is unhealthy. Drives the tools the agent calls, not just
  // the client functions.
  test('list_calendar_events tool returns seeded events with their UIDs', async () => {
    const uid = `tool-list-${Date.now()}@mcp-it`
    await putEvent(cfg, { calendarUrl, ical: invite(uid, 'Tool Listed'), token: TOKEN, uid })

    const result = await listCalendarEvents(makeListDeps(cfg), { args: { calendarUrl }, token: TOKEN })
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('Tool Listed')
    expect(text).toContain(`uid: ${uid}`)

    const obj = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    await deleteEvent(cfg, { token: TOKEN, url: obj?.url ?? '', ...(obj?.etag ? { etag: obj.etag } : {}) })
  })

  test('listing a calendar with no events returns an empty result, not an error', async () => {
    // A dedicated, never-populated collection guarantees emptiness regardless
    // of test ordering — mirrors the reported repro (delete all → list → []).
    const emptyUrl = withTrailingSlash(`${base}/${user}/mcp-it-empty`)
    const res = await fetch(emptyUrl, { headers: { authorization: basic }, method: 'MKCALENDAR' })
    if (!res.ok && res.status !== 405 && res.status !== 409) {
      throw new Error(`MKCALENDAR ${emptyUrl} failed: ${res.status}`)
    }

    expect(await fetchEvents(cfg, { calendarUrl: emptyUrl, token: TOKEN })).toEqual([])

    const result = await listCalendarEvents(makeListDeps(cfg), { args: { calendarUrl: emptyUrl }, token: TOKEN })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('No events found')
  })

  // MKCALENDAR path: the new collection lands under the principal's
  // calendar-home-set, carries the requested display name, and is immediately
  // discoverable by fetchCalendarList — i.e. usable by create_calendar_event.
  test('createCalendar makes a discoverable collection with the requested name', async () => {
    const name = `Marketing ${Date.now()}`
    const url = await createCalendar(cfg, { color: '#FF6600', name, token: TOKEN })
    expect(url).toContain(base)

    const calendars = await fetchCalendarList(cfg, TOKEN)
    const created = calendars.find((c) => withTrailingSlash(c.url) === withTrailingSlash(url))
    expect(created).toBeDefined()
    expect(created?.displayName).toBe(name)

    // Clean up the collection so repeated local runs don't accumulate calendars
    // (the event tests delete what they create; keep parity).
    await fetch(url, { headers: { authorization: basic }, method: 'DELETE' })
  })

  test('delete_calendar_event tool removes an event addressed by UID (filename differs)', async () => {
    const uid = `tool-del-${Date.now()}@mcp-it`
    await createCalendarObject({
      calendar: { url: calendarUrl },
      filename: `tool-del-named-${Date.now()}.ics`,
      headers: { authorization: basic },
      iCalString: invite(uid, 'Tool Delete'),
    })

    const result = await deleteCalendarEvent(makeDeleteDeps(cfg), { args: { calendarUrl, uid }, token: TOKEN })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('deleted')
    expect(await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })).toBeNull()
  })

  // The respond_to_event "CI moment": PUT an event whose ATTENDEE is our user
  // with PARTSTAT=NEEDS-ACTION, run the tool against the live server, and
  // assert the stored object now reads PARTSTAT=ACCEPTED. discover is stubbed
  // to a fixed address — Radicale doesn't expose calendar-user-address-set, so
  // the real discovery yields no organizer (other tool tests sidestep it the
  // same way); fetchEvent / updateEvent are the real client.
  test('respond_to_event flips the stored PARTSTAT to ACCEPTED', async () => {
    const uid = `rsvp-${Date.now()}@mcp-it`
    const me = `${user}@example.com`
    await putEvent(cfg, {
      calendarUrl,
      ical: buildInvite({
        attendees: [me],
        end: new Date('2026-06-12T10:30:00Z'),
        organizer: 'organizer@example.com',
        start: new Date('2026-06-12T10:00:00Z'),
        title: 'Invite to RSVP',
        uid,
      }),
      token: TOKEN,
      uid,
    })

    const seeded = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expect(seeded?.data).toContain('PARTSTAT=NEEDS-ACTION')

    const deps = {
      ...makeRespondDeps(cfg),
      discover: () =>
        Promise.resolve({
          calendars: [{ displayName: '', url: calendarUrl }],
          defaultCalendarUrl: calendarUrl,
          organizer: me,
        }),
    }
    const result = await respondToEvent(deps, { args: { calendarUrl, response: 'accept', uid }, token: TOKEN })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('Invite to RSVP')

    const updated = await fetchEvent(cfg, { calendarUrl, token: TOKEN, uid })
    expect(updated?.data).toContain('PARTSTAT=ACCEPTED')
    expect(updated?.data).not.toContain('PARTSTAT=NEEDS-ACTION')

    await deleteEvent(cfg, { token: TOKEN, url: updated?.url ?? '', ...(updated?.etag ? { etag: updated.etag } : {}) })
  })
})
