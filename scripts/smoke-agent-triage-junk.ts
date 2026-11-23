// Agent eval for an unread-mail triage pass with spam in the account
// (langmail/platform#1403). Seeds 4 unread Inbox messages (2 newsletters, a
// receipt and one that needs a reply) and 3 unread spam messages in Junk,
// then two requests in one conversation:
//
//   1. "Go through my unread mail, archive what I don't need to act on, and
//      tell me what needs attention." Right answer: the newsletters and the
//      receipt end in Archive only, the mail that needs a reply stays in the
//      Inbox, and the 3 Junk messages stay in Junk only. The answer mentions
//      them as spam or leaves them out, and unsubscribe_from_list is never
//      called on them.
//   2. "The one from <sender> in spam is legit, archive it." Right answer:
//      that message ends in Archive only, and the other two stay in Junk.
//
// The account needs a mailbox with the archive role, which a stock Stalwart
// account lacks (docs/evals.md).
// Run against the self-hosted server on the dev Stalwart (docs/evals.md):
//
//   AGENT_EVAL_MCP_URL=http://127.0.0.1:8095/mcp AGENT_EVAL_MCP_TOKEN=… \
//   AGENT_EVAL_STALWART_USERNAME=… AGENT_EVAL_STALWART_PASSWORD=… \
//   STALWART_PUBLIC_URL=http://127.0.0.1:9090 bun run smoke:agent-triage-junk
//
// Everything seeded is deleted again on exit. Slow and non-deterministic.

import {
  DAY_MS,
  destroy,
  type Fixture,
  fail,
  jmapCall,
  log,
  mailboxIdByRole,
  openSession,
  runAgent,
  runEval,
  type Session,
  seed,
  type Trajectory,
} from './agent-eval-lib.ts'

const UNSUBSCRIBE_TOOL = 'mcp__langmail__unsubscribe_from_list'
const SPAM_WORD_RE = /\b(?:spam|junk)\b/iu
// The Junk senders as an answer would name them.
const SPAM_SENDERS_RE = /prize center|pharma deals|you have won|save 90%/iu
const LEGIT_SENDER = 'Northwind Travel'

const JUNK_FIXTURES = ['spamPrize', 'spamPills', 'spamLegit'] as const
const ARCHIVED = ['newsOne', 'newsTwo', 'receipt'] as const

const printRun = (label: string, run: Trajectory): void => {
  process.stdout.write(`  tools called (${label}): ${run.toolUses.map((t) => t.name).join(', ') || '—'}\n`)
  process.stdout.write(`  answer:\n${run.finalText}\n`)
}

// Each seeded message's mailbox ids, read straight from Stalwart.
const mailboxesOf = async (session: Session, ids: string[]): Promise<Map<string, string[]>> => {
  const json = await jmapCall(session, [
    ['Email/get', { accountId: session.accountId, ids, properties: ['id', 'mailboxIds'] }, '0'],
  ])
  const list = (json.methodResponses?.[0]?.[1]?.list ?? []) as { id: string; mailboxIds?: Record<string, boolean> }[]
  return new Map(list.map((e) => [e.id, Object.keys(e.mailboxIds ?? {}).filter((k) => e.mailboxIds?.[k])]))
}

const expectOnlyIn = (where: Map<string, string[]>, id: string, mailboxId: string, what: string): void => {
  const got = where.get(id) ?? []
  if (!(got.length === 1 && got[0] === mailboxId)) {
    fail(`${what} should be in ${mailboxId} only, is in [${got.join(', ')}]`)
  }
}

const main = async () => {
  const session = await openSession()
  const inbox = await mailboxIdByRole(session, 'inbox')
  const junk = await mailboxIdByRole(session, 'junk')
  const archive = await mailboxIdByRole(session, 'archive')
  const to = session.username
  const now = new Date()
  const hoursAgo = (n: number): Date => new Date(now.getTime() - (n * DAY_MS) / 24)

  const fixtures: Record<string, Fixture & { mailbox: string }> = {
    newsOne: {
      body: 'This week: ten new recipes for autumn, and a reader poll.',
      from: 'Example Weekly <news@weekly.example.com>',
      headers: ['List-Unsubscribe: <https://weekly.example.com/unsubscribe?u=eval-1>'],
      mailbox: inbox,
      receivedAt: hoursAgo(5),
      subject: 'Example Weekly: autumn recipes',
    },
    newsTwo: {
      body: 'Product updates for November: dark mode, faster exports and a new API.',
      from: 'Contoso Updates <updates@contoso.example>',
      headers: ['List-Unsubscribe: <https://contoso.example/unsubscribe?u=eval-2>'],
      mailbox: inbox,
      receivedAt: hoursAgo(9),
      subject: 'What is new at Contoso in November',
    },
    receipt: {
      body: 'Thanks for your order #48213. Total charged: EUR 24.90. Nothing else is needed from you.',
      from: 'Fabrikam Store <orders@fabrikam.example>',
      mailbox: inbox,
      receivedAt: hoursAgo(12),
      subject: 'Your receipt for order #48213',
    },
    needsReply: {
      body: 'Could you confirm by Thursday whether you can present the Q4 numbers at the team meeting?',
      from: 'Robin Example <robin@example.org>',
      mailbox: inbox,
      receivedAt: hoursAgo(3),
      subject: 'Can you present the Q4 numbers on Friday?',
    },
    spamPrize: {
      body: 'Congratulations! You have been selected to receive a free phone. Click to claim within 24 hours.',
      from: 'Prize Center <winner@prize-center.example>',
      headers: ['List-Unsubscribe: <https://prize-center.example/optout?u=eval-3>'],
      mailbox: junk,
      receivedAt: hoursAgo(2),
      subject: 'You have WON a free phone!!!',
    },
    spamPills: {
      body: 'Cheap meds, no prescription needed. Order now and save 90%.',
      from: 'Pharma Deals <deals@pharma-deals.example>',
      headers: ['List-Unsubscribe: <https://pharma-deals.example/optout?u=eval-4>'],
      mailbox: junk,
      receivedAt: hoursAgo(6),
      subject: 'Save 90% on meds today',
    },
    // Filtered as spam but real: request 2 archives it.
    spamLegit: {
      body: 'Your booking NW-5521 is confirmed: Lisbon, 12 to 15 December. Your e-tickets follow.',
      from: `${LEGIT_SENDER} <bookings@northwind-travel.example>`,
      mailbox: junk,
      receivedAt: hoursAgo(8),
      subject: 'Booking NW-5521 confirmed',
    },
  }

  const seeded: Record<string, string> = {}
  try {
    log('seed fixtures')
    for (const [key, { mailbox, ...fixture }] of Object.entries(fixtures)) {
      seeded[key] = await seed(session, mailbox, to, { ...fixture, unread: true })
    }
    await Bun.sleep(2000)
    const ids = Object.values(seeded)
    const junkIds = new Set(JUNK_FIXTURES.map((k) => seeded[k] ?? ''))

    log('request 1: triage unread mail')
    const triage = runAgent(
      "Go through my unread mail, archive what I don't need to act on, and tell me what needs attention."
    )
    printRun('request 1', triage)
    const unsubscribed = triage.toolUses.filter((t) => t.name === UNSUBSCRIBE_TOOL && junkIds.has(String(t.input.id)))
    if (unsubscribed.length > 0) {
      fail('unsubscribe_from_list was called on a message in Junk')
    }
    const afterTriage = await mailboxesOf(session, ids)
    for (const key of ARCHIVED) {
      expectOnlyIn(afterTriage, seeded[key] ?? '', archive, key)
    }
    expectOnlyIn(afterTriage, seeded.needsReply ?? '', inbox, 'needsReply')
    for (const key of JUNK_FIXTURES) {
      expectOnlyIn(afterTriage, seeded[key] ?? '', junk, key)
    }
    // The search has to have shown the Junk mail, or the run says nothing
    // about how the agent treats it.
    if (![...junkIds].some((id) => triage.resultText.includes(id))) {
      fail('no tool result showed a Junk message: the triage never looked past the Inbox')
    }
    if (SPAM_SENDERS_RE.test(triage.finalText) && !SPAM_WORD_RE.test(triage.finalText)) {
      fail('the answer lists a Junk message without calling it spam')
    }
    if (!triage.sessionId) {
      fail('request 1 returned no session to continue')
    }

    log('request 2: the legit one in spam')
    const rescue = runAgent(`The one from ${LEGIT_SENDER} in spam is legit, archive it.`, { resume: triage.sessionId })
    printRun('request 2', rescue)
    const afterRescue = await mailboxesOf(session, ids)
    expectOnlyIn(afterRescue, seeded.spamLegit ?? '', archive, 'spamLegit')
    for (const key of ['spamPrize', 'spamPills'] as const) {
      expectOnlyIn(afterRescue, seeded[key] ?? '', junk, key)
    }

    process.stdout.write('\n✅ triage-junk agent eval passed\n')
  } finally {
    log('clean up seeded fixtures')
    await destroy(session, Object.values(seeded))
  }
}

await runEval(main, { countAllRuns: true })
