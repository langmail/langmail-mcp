// Agent eval for a series from an Outlook invitation (#1260): its TZID is a
// Windows zone name (`W. Europe Standard Time`) with the object's own
// VTIMEZONE, one occurrence is cancelled and one moved. Asked "What's on my
// calendar in the next two weeks?", the right answer names each remaining
// occurrence at 10:00 Berlin time and the moved one at 14:00.
//
// The series is seeded through CalDAV into the default calendar and deleted on
// exit. Run per docs/guides/local-development.md § Agent trajectory evals,
// against the hosted or the self-hosted server.

import { deleteEvent, discoverAccount, fetchEvents, findEventObject, putEvent } from '../src/caldav/client.ts'
import { calDav, DAY_MS, fail, log, runAgent, runEval } from './agent-eval-lib.ts'

// The eval library's credentials: a Langmail token hosted, the Stalwart app
// password self-hosted.
const { cfg, token } = calDav
const UID = `outlook-${crypto.randomUUID()}@example.com`
const TITLE = 'Vendor sync'
const ZONE = 'W. Europe Standard Time'

// `YYYYMMDD` of the UTC day `days` from today.
const dayFromToday = (days: number): string =>
  new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10).replaceAll('-', '')
const iso = (ymd: string): string => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`

// Every other day from a week ago, so the stored start lies before the window.
const START = dayFromToday(-6)
const CANCELLED = dayFromToday(2)
const MOVED = dayFromToday(4)
const KEPT = [dayFromToday(6), dayFromToday(8)]

const fixture = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:Microsoft Exchange Server 2010',
  'BEGIN:VTIMEZONE',
  `TZID:${ZONE}`,
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  `UID:${UID}`,
  `SUMMARY:${TITLE}`,
  `DTSTART;TZID=${ZONE}:${START}T100000`,
  `DTEND;TZID=${ZONE}:${START}T110000`,
  'RRULE:FREQ=DAILY;INTERVAL=2',
  `EXDATE;TZID=${ZONE}:${CANCELLED}T100000`,
  'DTSTAMP:20261101T090000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  `UID:${UID}`,
  `SUMMARY:${TITLE}`,
  `RECURRENCE-ID;TZID=${ZONE}:${MOVED}T100000`,
  `DTSTART;TZID=${ZONE}:${MOVED}T140000`,
  `DTEND;TZID=${ZONE}:${MOVED}T150000`,
  'DTSTAMP:20261101T090000Z',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

const TEN_RE = /\b10(?::00|\s?(?:am|a\.m\.))/iu
const FOURTEEN_RE = /\b(?:14:00|2(?::00)?\s?(?:pm|p\.m\.))/iu

const main = async () => {
  const account = await discoverAccount(cfg, token)
  const calendarUrl = account.defaultCalendarUrl
  if (!calendarUrl) {
    throw new Error('the account has no default calendar')
  }
  try {
    log(`seed the Outlook series (cancelled ${iso(CANCELLED)}, moved ${iso(MOVED)})`)
    await putEvent(cfg, { calendarUrl, ical: fixture, token })

    log('run the agent')
    const { finalText, resultText, toolUses } = runAgent("What's on my calendar in the next two weeks?")
    process.stdout.write(`  tools called: ${toolUses.map((t) => t.name).join(', ') || '—'}\n`)
    process.stdout.write(`  answer:\n${finalText}\n`)

    // What the agent was shown: every remaining occurrence at its wall clock (a
    // moved one also names its old time, as `moved from`, so only `when:` counts).
    for (const day of KEPT) {
      if (!resultText.includes(`when: ${iso(day)}T10:00:00`)) {
        fail(`the agent was not shown the ${iso(day)} occurrence at 10:00`)
      }
    }
    if (!resultText.includes(`when: ${iso(MOVED)}T14:00:00`)) {
      fail(`the agent was not shown the moved occurrence at 14:00 on ${iso(MOVED)}`)
    }
    if (
      resultText.includes(`when: ${iso(CANCELLED)}T10:00:00`) ||
      resultText.includes(`when: ${iso(MOVED)}T10:00:00`)
    ) {
      fail('the agent was shown the cancelled occurrence or the moved one at its old time')
    }
    // What the user reads: the series, at 10:00, and the moved one at 14:00.
    if (!(finalText.includes(TITLE) && TEN_RE.test(finalText) && FOURTEEN_RE.test(finalText))) {
      fail(`the answer does not give ${TITLE} at 10:00 and the moved occurrence at 14:00`)
    }
    process.stdout.write('\n✅ windows-zone agent eval passed\n')
  } finally {
    log('clean up')
    const stored = findEventObject(await fetchEvents(cfg, { calendarUrl, token }), UID)
    if (stored) {
      await deleteEvent(cfg, { token, url: stored.url, ...(stored.etag ? { etag: stored.etag } : {}) })
    }
  }
}

await runEval(main)
