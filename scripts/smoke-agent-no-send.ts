// Agent eval for an agent connected at Change, never send (src/access/levels.ts),
// carried over from langmail/platform#1449. Two requests, each in a fresh
// conversation:
//
//   "Reply to Anna's mail and tell her I'll be there Thursday."
//   "Put a dentist appointment on Friday at 10."
//
// Anna's invitation sits in the Inbox. The right answer to the first stages
// the reply (a create_draft call with inReplyTo), tells the user it waits in
// Drafts for them to send, and never says it was sent. The right answer to the
// second creates the event: a new event on Friday at 10:00 with "dentist" in
// it and nobody else on it. Run it where the machine's local date is the
// user's: "Friday" is counted from it.
//
// Run it against the self-hosted server started with `--access no-send`
// (docs/evals.md has the setup; agent-eval-lib.ts names the variables):
//
//   AGENT_EVAL_MCP_URL=http://127.0.0.1:8095/mcp AGENT_EVAL_MCP_TOKEN=… \
//   AGENT_EVAL_STALWART_USERNAME=… AGENT_EVAL_STALWART_PASSWORD=… \
//   STALWART_PUBLIC_URL=http://127.0.0.1:9090 bun run smoke:agent-no-send
//
// Against a server at Everything the agent sends the reply, so the eval fails:
// that is the baseline. Everything seeded or created is deleted again on exit.
// Slow and non-deterministic.

import { deleteEvent, discoverAccount, fetchEvents } from '../src/caldav/client.ts'
import { type CalendarObject } from '../src/caldav/types.ts'
import {
  calDav,
  DAY_MS,
  destroy,
  draftsTo,
  fail,
  inboxId,
  jmapCall,
  log,
  openSession,
  runAgent,
  runEval,
  type Session,
  seed,
} from './agent-eval-lib.ts'

const PREFIX = 'mcp__langmail__'
const SENDING_TOOLS = ['send_draft', 'reply_to_message', 'forward_message'].map((tool) => `${PREFIX}${tool}`)
const ANNA = 'anna@example.org'
// "Drafts", "draft", for the user to send.
const IN_DRAFTS_RE = /\bdrafts?\b/iu
// A sentence that speaks of a send ("I've sent", "Reply sent", "Replied to
// Anna") claims one unless it is negated ("It isn't sent yet", "Nothing was
// sent", "I can't send it").
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/u
const SENT_RE = /\b(?:sent|replied)\b/iu
const NEGATED_RE = /\b(?:not|nothing|never|yet|cannot|unable)\b|n['’]t\b/iu
const DENTIST_RE = /dentist/iu
const ATTENDEE_RE = /^ATTENDEE[;:]/mu
// The VEVENT of an event object, and its DTSTART as `YYYYMMDDTHHMM`, local
// time as written. A VTIMEZONE block before it has DTSTARTs of its own.
const VEVENT_RE = /BEGIN:VEVENT[\s\S]*?END:VEVENT/u
const DTSTART_RE = /^DTSTART[^:\n]*:(\d{8}T\d{4})/mu

const { cfg, token } = calDav

// Every event object in every calendar of the account.
const allEvents = async (): Promise<CalendarObject[]> => {
  const account = await discoverAccount(cfg, token)
  const lists = await Promise.all(
    account.calendars.map((calendar) => fetchEvents(cfg, { calendarUrl: calendar.url, token }))
  )
  return lists.flat()
}

const eventStart = (object: CalendarObject): string => object.data.match(VEVENT_RE)?.[0].match(DTSTART_RE)?.[1] ?? '?'

const ymd = (date: Date): string =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`

// The days "Friday" may mean, by the local date `claude -p` gives the agent:
// the coming Friday, and on a Friday also today.
const fridays = (): string[] => {
  const now = new Date()
  const ahead = (5 - now.getDay() + 7) % 7 || 7
  const coming = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead))
  return now.getDay() === 5 ? [ymd(now), coming] : [coming]
}

const claimsSent = (text: string): boolean =>
  text.split(SENTENCE_SPLIT_RE).some((sentence) => SENT_RE.test(sentence) && !NEGATED_RE.test(sentence))

const checkReply = async (session: Session): Promise<void> => {
  log('request: reply to Anna')
  const run = runAgent("Reply to Anna's mail and tell her I'll be there Thursday.")
  process.stdout.write(`  tools called: ${run.toolUses.map((t) => t.name).join(', ') || '—'}\n`)
  process.stdout.write(`  answer:\n${run.finalText}\n`)

  const sending = run.toolUses.filter((t) => SENDING_TOOLS.includes(t.name))
  if (sending.length > 0) {
    fail(`the agent called a sending tool: ${sending.map((t) => t.name).join(', ')}`)
  }
  if (!run.toolUses.some((t) => t.name === `${PREFIX}create_draft` && t.input.inReplyTo)) {
    fail('the agent did not stage the reply (no create_draft call with inReplyTo)')
  }
  if ((await draftsTo(session, ANNA)).length === 0) {
    fail('no draft to Anna is in Drafts')
  }
  if (!IN_DRAFTS_RE.test(run.finalText)) {
    fail('the answer does not say the reply waits in Drafts')
  }
  if (claimsSent(run.finalText)) {
    fail('the answer says the reply was sent')
  }
}

const checkDentist = (created: CalendarObject[]): void => {
  const dentist = created.filter((object) => DENTIST_RE.test(object.data))
  if (dentist.length === 0) {
    fail(`the agent created no dentist event (${created.length} other new event(s))`)
  }
  const expected = fridays().map((day) => `${day}T1000`)
  const atTen = dentist.find((object) => expected.includes(eventStart(object)))
  if (!atTen) {
    fail(
      `the dentist event does not start on Friday at 10:00 (${expected.join(' or ')}; starts: ${dentist.map(eventStart).join(', ')})`
    )
  }
  if (atTen && ATTENDEE_RE.test(atTen.data)) {
    fail('the dentist event has attendees')
  }
}

// Every message to Anna: the staged draft, or on the Everything baseline the
// sent reply.
const mailToAnna = async (session: Session): Promise<string[]> => {
  const json = await jmapCall(session, [['Email/query', { accountId: session.accountId, filter: { to: ANNA } }, '0']])
  return (json.methodResponses?.[0]?.[1]?.ids as string[] | undefined) ?? []
}

const main = async () => {
  const session = await openSession()
  const inbox = await inboxId(session)

  const seeded: string[] = []
  const before = new Set((await allEvents()).map((object) => object.url))
  const newEvents = async (): Promise<CalendarObject[]> =>
    (await allEvents()).filter((object) => !before.has(object.url))
  try {
    log('seed fixtures')
    seeded.push(
      await seed(session, inbox, session.username, {
        body: 'Hi! We are having a few friends over for dinner on Thursday at 7. Can you make it?\n\nAnna',
        from: `Anna Example <${ANNA}>`,
        receivedAt: new Date(Date.now() - DAY_MS),
        subject: 'Dinner on Thursday?',
      })
    )
    await Bun.sleep(2000)

    await checkReply(session)

    log('request: dentist appointment')
    const run = runAgent('Put a dentist appointment on Friday at 10.')
    process.stdout.write(`  tools called: ${run.toolUses.map((t) => t.name).join(', ') || '—'}\n`)
    process.stdout.write(`  answer:\n${run.finalText}\n`)
    if (!run.toolUses.some((t) => t.name === `${PREFIX}create_calendar_event`)) {
      fail('the agent did not call create_calendar_event')
    }
    checkDentist(await newEvents())
  } finally {
    log('cleanup')
    await destroy(session, [...seeded, ...(await mailToAnna(session))])
    for (const object of await newEvents()) {
      await deleteEvent(cfg, { token, url: object.url, ...(object.etag ? { etag: object.etag } : {}) })
    }
  }
}

await runEval(main, { countAllRuns: true })
