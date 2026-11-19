// Agent-retrieval eval for the self-hosted server (src/self-hosted.ts), where
// no email-agent classifies mail: search_emails has no type filter, and the
// to-do flag mark_emails sets has a filter of its own, and no Langmail account
// exists for the agent to send the user to. Four requests:
//
//   1. "Find my train ticket for next week": the ticket carries no `$type:`
//      keyword and is titled after its route, as a real one is. The agent has
//      to find it by its words and a date window, without a call that passes a
//      type filter (the self-hosted schema has none, so such a call is a
//      rejected argument and a wasted turn).
//   2. "What is on my to-do list?": two mails carry the `$label:todo` keyword
//      mark_emails sets for `todo: true`; a third is merely starred. The answer
//      is exactly the two.
//   3. "Draft a reply to Dana Example saying I'll be there.": one draft staged
//      as a reply to Dana's mail, nothing sent, and the answer says it waits
//      in the Drafts folder, without the word "Langmail".
//   4. "Unsubscribe me from Example Weekly": the newsletter has an https
//      unsubscribe link but no one-click header, so nothing can be sent. The
//      answer says nothing was sent and gives the link to open in a browser,
//      without the word "Langmail".
//
// Run against the self-hosted server on the dev Stalwart, with no Langmail
// account (agent-eval-lib.ts names the variables):
//
//   AGENT_EVAL_MCP_URL=http://127.0.0.1:8095/mcp AGENT_EVAL_MCP_TOKEN=… \
//   AGENT_EVAL_STALWART_USERNAME=… AGENT_EVAL_STALWART_PASSWORD=… \
//   STALWART_PUBLIC_URL=http://127.0.0.1:9090 bun run smoke:agent-self-hosted
//
// Everything seeded is deleted again on exit. Slow and non-deterministic.

// The keyword mark_emails sets and the todo filter reads, so a drift between
// the two fails here.
import { TODO_KEYWORD } from '../src/tools/keywords.ts'
import {
  DAY_MS,
  destroy,
  draftsTo,
  type Fixture,
  fail,
  inboxId,
  log,
  openSession,
  runAgent,
  runEval,
  type Session,
  seed,
  type Trajectory,
} from './agent-eval-lib.ts'

const SEARCH_TOOL = 'mcp__langmail__search_emails'
const DRAFT_TOOL = 'mcp__langmail__create_draft'
const SENDING_TOOLS = new Set(['send_draft', 'reply_to_message', 'forward_message'].map((t) => `mcp__langmail__${t}`))
const DANA = 'dana@example.org'
const UNSUBSCRIBE_LINK = 'https://weekly.example.com/unsubscribe?u=eval-7f3a'
// A negated send: "Nothing was sent", "I didn't send", "it can't be called".
const NOTHING_SENT_RE =
  /\b(?:nothing|not|never|no|cannot|\w+n['’]t)\b[^.\n]{0,60}\b(?:sent|send|call(?:ed)?|request|automatically)\b/iu
// "You've been unsubscribed", "I unsubscribed you", "successfully unsubscribed".
const UNSUBSCRIBED_CLAIM_RE =
  /\b(?:you(?:['’]ve| have) been|you are now|successfully|I(?:['’]ve| have)?)\s+unsubscribed\b/iu
// The Drafts folder by name, not merely "the draft".
const DRAFTS_FOLDER_RE = /\bDrafts\b|\bdrafts (?:folder|mailbox)\b/u

const langmailCalls = (toolUses: { name: string }[]): number =>
  toolUses.filter((t) => t.name.startsWith('mcp__langmail__')).length

// Request 3: one draft, staged as a reply, nothing sent, and an answer that
// points to the Drafts folder rather than to Langmail. `staged` collects the
// draft for the cleanup.
const requestDraftReply = async (session: Session, seeded: Record<string, string>, staged: string[]): Promise<void> => {
  log('request 3: draft a reply')
  const draftsBefore = new Set(await draftsTo(session, DANA))
  let draftRun: Trajectory
  try {
    draftRun = runAgent("Draft a reply to Dana Example saying I'll be there.")
  } finally {
    // Collected even when the agent run crashes, so the cleanup finds them.
    staged.push(...(await draftsTo(session, DANA)).filter((id) => !draftsBefore.has(id)))
  }
  process.stdout.write(`  tools called: ${draftRun.toolUses.map((t) => t.name).join(', ') || '—'}\n`)
  process.stdout.write(`  tool calls (request 3): ${langmailCalls(draftRun.toolUses)}\n`)
  process.stdout.write(`  answer:\n${draftRun.finalText}\n`)
  const sent = draftRun.toolUses.filter((t) => SENDING_TOOLS.has(t.name))
  if (sent.length > 0) {
    fail(`the agent sent mail: ${sent.map((t) => t.name).join(', ')}`)
  }
  if (staged.length !== 1) {
    fail(`expected one new draft to ${DANA}, found ${staged.length}`)
  }
  const replies = draftRun.toolUses.filter((t) => t.name === DRAFT_TOOL && t.input.inReplyTo === seeded.invite)
  if (replies.length === 0) {
    fail('the draft was not staged as a reply to Dana’s mail (no create_draft with her message as inReplyTo)')
  }
  if (!DRAFTS_FOLDER_RE.test(draftRun.finalText)) {
    fail('the answer does not say the draft waits in the Drafts folder')
  }
  if (draftRun.finalText.includes('Langmail')) {
    fail('the answer names Langmail')
  }
}

// Request 4: nothing can be sent, so the answer says so and gives the link.
const requestUnsubscribe = (): void => {
  log('request 4: unsubscribe without one-click')
  const unsubscribeRun = runAgent('Unsubscribe me from Example Weekly.')
  process.stdout.write(`  tools called: ${unsubscribeRun.toolUses.map((t) => t.name).join(', ') || '—'}\n`)
  process.stdout.write(`  tool calls (request 4): ${langmailCalls(unsubscribeRun.toolUses)}\n`)
  process.stdout.write(`  answer:\n${unsubscribeRun.finalText}\n`)
  if (!unsubscribeRun.finalText.includes(UNSUBSCRIBE_LINK)) {
    fail('the answer does not give the unsubscribe link')
  }
  if (!NOTHING_SENT_RE.test(unsubscribeRun.finalText)) {
    fail('the answer does not say nothing was sent')
  }
  if (UNSUBSCRIBED_CLAIM_RE.test(unsubscribeRun.finalText)) {
    fail('the answer claims the user is unsubscribed')
  }
  if (unsubscribeRun.finalText.includes('Langmail')) {
    fail('the answer names Langmail')
  }
}

const main = async () => {
  const session = await openSession()
  const mailboxId = await inboxId(session)
  const to = session.username

  const now = new Date()
  const daysAgo = (n: number): Date => new Date(now.getTime() - n * DAY_MS)
  // Wednesday of next week, so "next week" is unambiguous whatever today is.
  const daysToNextMonday = (8 - now.getUTCDay()) % 7 || 7
  const travelDay = new Date(now.getTime() + (daysToNextMonday + 2) * DAY_MS).toISOString().slice(0, 10)

  const fixtures: Record<string, Fixture> = {
    // The target: titled after the route, booked last week for a trip next
    // week, with no type keyword.
    ticket: {
      body: `Your journey on ${travelDay}: Munich Hbf 08:14 → Berlin Hbf 12:46, ICE 504, coach 7, seat 61. Show this booking code on board: KX7Q2M.`,
      from: 'Rail Booking <tickets@rail-booking.example>',
      receivedAt: daysAgo(4),
      subject: 'Munich → Berlin, your booking KX7Q2M',
    },
    // A newsletter that talks about trains, to make a bare free-text match noisy.
    bait: {
      body: 'Autumn deals: cheap train tickets across the country. Book now!',
      from: 'Rail Booking <news@rail-booking.example>',
      receivedAt: daysAgo(2),
      subject: 'Autumn rail deals',
    },
    todoOne: {
      body: 'Could you sign the attached lease renewal and send it back by Friday?',
      from: 'Landlord <landlord@example.org>',
      receivedAt: daysAgo(3),
      subject: 'Lease renewal to sign',
      typeKeyword: TODO_KEYWORD,
    },
    todoTwo: {
      body: 'Please send your tax documents for this year so we can file.',
      from: 'Tax Advisor <office@tax-advisor.example>',
      receivedAt: daysAgo(5),
      subject: 'Documents for your tax return',
      typeKeyword: TODO_KEYWORD,
    },
    // Starred, not a to-do: the todo filter must not pick it up.
    starred: {
      body: 'Photos from the weekend are attached.',
      from: 'Sam <sam@example.org>',
      receivedAt: daysAgo(1),
      subject: 'Weekend photos',
      typeKeyword: '$flagged',
    },
    // The mail request 3 replies to.
    invite: {
      body: 'We are meeting at the boathouse on Saturday at 11. Will you join us?',
      from: `Dana Example <${DANA}>`,
      receivedAt: daysAgo(1),
      subject: 'Saturday at the boathouse',
    },
    // Request 4: an https link, but no List-Unsubscribe-Post, so no one-click.
    newsletter: {
      body: 'This week: ten new recipes for autumn.',
      from: 'Example Weekly <news@weekly.example.com>',
      headers: [`List-Unsubscribe: <${UNSUBSCRIBE_LINK}>`],
      receivedAt: daysAgo(2),
      subject: 'Example Weekly: autumn recipes',
    },
  }

  const seeded: Record<string, string> = {}
  // Drafts the agent stages in request 3, deleted on exit too.
  const staged: string[] = []
  try {
    log('seed fixtures')
    for (const [key, fixture] of Object.entries(fixtures)) {
      seeded[key] = await seed(session, mailboxId, to, fixture)
    }
    await Bun.sleep(2000)

    log('request 1: the train ticket')
    const ticketRun = runAgent(
      `Today is ${now.toISOString().slice(0, 10)}. Find my train ticket for next week. ` +
        'Tell me the exact subject of the booking mail and its message id.'
    )
    const ticketSearches = ticketRun.toolUses.filter((t) => t.name === SEARCH_TOOL)
    process.stdout.write(`  tools called: ${ticketRun.toolUses.map((t) => t.name).join(', ') || '—'}\n`)
    for (const s of ticketSearches) {
      process.stdout.write(`  search_emails ${JSON.stringify(s.input)}\n`)
    }
    const typeFiltered = ticketSearches.filter((s) => 'keywords' in (s.input ?? {}))
    if (typeFiltered.length > 0) {
      fail(`a search_emails call passed a type filter: ${JSON.stringify(typeFiltered[0]?.input)}`)
    }
    // The answer names the ticket, not the train-deals newsletter.
    if (!ticketRun.finalText.includes(seeded.ticket ?? '')) {
      fail('the answer does not name the seeded train ticket')
    }
    if (ticketRun.finalText.includes(seeded.bait ?? '')) {
      fail('the answer names the newsletter as the ticket')
    }

    log('request 2: the to-do list')
    const todoRun = runAgent(
      'What is on my to-do list? List the message id of every mail on it, and nothing that is not on it.'
    )
    process.stdout.write(`  tools called: ${todoRun.toolUses.map((t) => t.name).join(', ') || '—'}\n`)
    for (const s of todoRun.toolUses.filter((t) => t.name === SEARCH_TOOL)) {
      process.stdout.write(`  search_emails ${JSON.stringify(s.input)}\n`)
    }
    // The answer, not the tool output: a broader search may have shown other
    // mail on the way.
    for (const key of ['todoOne', 'todoTwo']) {
      if (!todoRun.finalText.includes(seeded[key] ?? '')) {
        fail(`the to-do mail ${key} is missing from the answer`)
      }
    }
    for (const key of ['ticket', 'bait', 'starred']) {
      if (todoRun.finalText.includes(seeded[key] ?? '')) {
        fail(`${key} is not a to-do but was listed as one`)
      }
    }

    await requestDraftReply(session, seeded, staged)
    requestUnsubscribe()

    process.stdout.write('\n✅ self-hosted agent eval passed\n')
  } finally {
    log('clean up seeded fixtures')
    await destroy(session, [...Object.values(seeded), ...staged])
  }
}

await runEval(main, { countAllRuns: true })
