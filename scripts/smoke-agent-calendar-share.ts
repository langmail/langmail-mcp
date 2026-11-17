// Agent eval for calendar sharing (#1258), five requests in a row on an
// account with the calendars Personal and Family, each a fresh agent:
//
//   1. "Share my Personal calendar with Sam, just busy times."
//      → a busy-only link for Sam on Personal, plus the refresh note. The
//        link serves Personal's event as "Busy", without its title.
//   2. "Give my partner full details of the Family calendar."
//      → a full-details link on Family, which serves its event's title.
//   3. "Who can see my calendars?"
//      → Sam (busy, Personal) and the partner (full, Family).
//   4. "Stop sharing my calendar with Sam."
//      → Sam's link shows an empty calendar; the partner's still serves.
//   5. "Rename my Family calendar to Home."
//      → renamed, and no share changes.
//
// The verdict line counts the calls of all five. The calendars are created
// over CalDAV (or reused when the account already has one by that name) and
// deleted on exit with any share left on them. Run per
// docs/guides/local-development.md § Agent trajectory evals.

import { createCalendar, fetchCalendarList, putEvent, updateCalendar } from '../src/caldav/client.ts'
import { DAY_MS, fail, log, runAgent, runEval, type Trajectory } from './agent-eval-lib.ts'

const cfg = { serverUrl: process.env.STALWART_PUBLIC_URL ?? '' }
const token = process.env.MCP_ACCESS_TOKEN ?? ''
const mcpUrl = process.env.AGENT_EVAL_MCP_URL ?? ''

const SHARE = 'mcp__langmail__share_calendar'
const STOP = 'mcp__langmail__stop_sharing_calendar'
const RENAME = 'mcp__langmail__update_calendar'
const LANGMAIL = 'mcp__langmail__'

const PERSONAL_EVENT = 'Dentist appointment'
const FAMILY_EVENT = 'Grandma dinner'

const LINK_RE = /https?:\/\/[^\s)>\]"'`]+\/calendar-feeds\/[A-Za-z0-9_-]{43}\.ics/gu
// The person's app sets the refresh: "how often it updates", "refreshes every …".
const REFRESH_RE = /how often|refresh/iu
const PERSONAL_RE = /personal/iu
const SAM_RE = /\bsam\b/iu
const PARTNER_RE = /partner/iu
const BUSY_RE = /busy/iu
const FULL_RE = /full/iu
const BUSY_LINE_RE = /SUMMARY:Busy/u

const STAMP_SEPARATORS_RE = /[-:]/gu
const STAMP_MILLIS_RE = /\.\d{3}/u

const stamp = (d: Date): string => d.toISOString().replaceAll(STAMP_SEPARATORS_RE, '').replace(STAMP_MILLIS_RE, '')

const event = (title: string, at: Date): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Langmail//agent eval//EN',
    'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}@example.com`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(at)}`,
    `DTEND:${stamp(new Date(at.getTime() + 3_600_000))}`,
    `SUMMARY:${title}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')

const fetchFeed = async (link: string): Promise<string> => {
  const res = await fetch(link)
  if (res.status !== 200) {
    fail(`${link} answered ${res.status}`)
  }
  return res.text()
}

const linksIn = (t: Trajectory): string[] => [...new Set(t.finalText.match(LINK_RE) ?? [])]

const langmailCalls = (t: Trajectory) => t.toolUses.filter((u) => u.name.startsWith(LANGMAIL))

const report = (t: Trajectory): void => {
  process.stdout.write(
    `  tools called: ${
      langmailCalls(t)
        .map((u) => u.name)
        .join(', ') || '—'
    }\n`
  )
}

// One tool call straight to the MCP server, for clean-up only.
const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const res = await fetch(mcpUrl, {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: { arguments: args, name } }),
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  })
  return res.text()
}

const findCalendar = async (name: string) =>
  (await fetchCalendarList(cfg, token)).find((c) => c.displayName.toLowerCase() === name.toLowerCase())

// 1. A busy-only link for Sam on Personal, with the refresh note; returns the link.
const shareWithSam = async (): Promise<string> => {
  log('1. share Personal with Sam, busy only')
  const run = agent('Share my Personal calendar with Sam, just busy times.')
  report(run)
  const shared = run.toolUses.find((u) => u.name === SHARE)
  if (
    !(
      shared &&
      shared.input.level === 'busy' &&
      SAM_RE.test(String(shared.input.with)) &&
      PERSONAL_RE.test(String(shared.input.calendar))
    )
  ) {
    fail(`no busy-only share_calendar for Sam: ${JSON.stringify(shared?.input ?? null)}`)
  }
  const links = linksIn(run)
  if (links.length !== 1) {
    fail(`expected one link in the answer, got ${JSON.stringify(links)}`)
  }
  if (!(REFRESH_RE.test(run.finalText) && BUSY_RE.test(run.finalText))) {
    fail(`the answer does not say it is busy times only and who sets the refresh: ${run.finalText}`)
  }
  const link = links[0] ?? fail('no link in the answer')
  const feed = await fetchFeed(link)
  if (feed.includes(PERSONAL_EVENT) || !BUSY_LINE_RE.test(feed)) {
    fail("Sam's link does not serve Personal as busy times only")
  }
  return link
}

// 2. A full-details link on Family; returns the link.
const shareWithPartner = async (): Promise<string> => {
  log('2. share Family with the partner, full details')
  const run = agent('Give my partner full details of the Family calendar.')
  report(run)
  const link = linksIn(run)[0] ?? fail('no link in the answer')
  if (!(await fetchFeed(link)).includes(FAMILY_EVENT)) {
    fail("the partner's link does not serve Family with full details")
  }
  return link
}

// 3. Sam (busy, Personal) and the partner (full, Family).
const whoCanSee = (): void => {
  log('3. who can see my calendars')
  const run = agent('Who can see my calendars?')
  report(run)
  const answer = run.finalText
  if (!(SAM_RE.test(answer) && PARTNER_RE.test(answer) && BUSY_RE.test(answer) && FULL_RE.test(answer))) {
    fail(`the answer does not name Sam (busy) and the partner (full): ${answer}`)
  }
}

// 4. Sam's link goes empty; the partner's keeps serving.
const stopSam = async (samLink: string, partnerLink: string): Promise<void> => {
  log('4. stop sharing with Sam')
  const run = agent('Stop sharing my calendar with Sam.')
  report(run)
  if (!run.toolUses.some((u) => u.name === STOP)) {
    fail('stop_sharing_calendar was not called')
  }
  if ((await fetchFeed(samLink)).includes('BEGIN:VEVENT')) {
    fail("Sam's link still serves events")
  }
  if (!(await fetchFeed(partnerLink)).includes(FAMILY_EVENT)) {
    fail("the partner's share changed")
  }
}

// 5. Family is renamed Home, and no share changes.
const renameFamily = async (partnerLink: string): Promise<void> => {
  log('5. rename Family to Home')
  const run = agent('Rename my Family calendar to Home.')
  report(run)
  if (run.toolUses.some((u) => u.name === SHARE || u.name === STOP)) {
    fail('a share changed during the rename')
  }
  if (!(run.toolUses.some((u) => u.name === RENAME) && (await findCalendar('Home')))) {
    fail('Family was not renamed to Home')
  }
  if (!(await fetchFeed(partnerLink)).includes(FAMILY_EVENT)) {
    fail("the partner's link stopped serving after the rename")
  }
}

// Every label the agent shared with, so clean-up stops each one.
const sharedWith = new Set<string>(['Sam'])

const agent = (prompt: string): Trajectory => {
  const run = runAgent(prompt)
  for (const use of run.toolUses) {
    if (use.name === SHARE && typeof use.input.with === 'string') {
      sharedWith.add(use.input.with)
    }
  }
  return run
}

const main = async () => {
  if (!mcpUrl) {
    fail('set AGENT_EVAL_MCP_URL: this eval creates and deletes calendars')
  }
  const created: string[] = []
  const ensure = async (name: string): Promise<string> => {
    const existing = await findCalendar(name)
    if (existing) {
      return existing.url
    }
    const url = await createCalendar(cfg, { name, token })
    created.push(url)
    return url
  }
  let familyUrl = ''
  try {
    log('seed the calendars Personal and Family, one event each')
    const personalUrl = await ensure('Personal')
    familyUrl = await ensure('Family')
    const tomorrow = new Date(Date.now() + DAY_MS)
    tomorrow.setUTCHours(9, 0, 0, 0)
    await putEvent(cfg, { calendarUrl: personalUrl, ical: event(PERSONAL_EVENT, tomorrow), token })
    await putEvent(cfg, { calendarUrl: familyUrl, ical: event(FAMILY_EVENT, tomorrow), token })

    const samLink = await shareWithSam()
    const partnerLink = await shareWithPartner()
    whoCanSee()
    await stopSam(samLink, partnerLink)
    await renameFamily(partnerLink)
    process.stdout.write('\n✅ calendar-share agent eval passed\n')
  } finally {
    log('clean up')
    for (const person of sharedWith) {
      await callTool('stop_sharing_calendar', { with: person }).catch(() => '')
    }
    for (const url of created) {
      await fetch(url, { headers: { authorization: `Bearer ${token}` }, method: 'DELETE' }).catch(() => undefined)
    }
    if (familyUrl && !created.includes(familyUrl)) {
      await updateCalendar(cfg, { name: 'Family', token, url: familyUrl }).catch(() => undefined)
    }
  }
}

await runEval(main, { countAllRuns: true })
