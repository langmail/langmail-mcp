// Agent-retrieval eval for the email-type filter (ADR 0010). Seeds a mailbox
// with a known fixture set, drives the deployed MCP server through `claude -p`
// with the session's own request — "show me the cinema tickets of yesterday's
// show" — and asserts on the observed tool-use trajectory (see
// agent-eval-lib.ts for why trajectory, not self-report).
//
// The fixtures make both halves of the guidance load-bearing:
//
//   - the target booking confirmation carries `$type:ticket`, arrives two days
//     before "today", and is for a show that ran yesterday — so it sits
//     OUTSIDE a literal "yesterday" received-date window. Finding it requires
//     widening the window by a booking lead time, which the after/before
//     descriptions tell the model to do.
//   - a second, older `$type:ticket` message (a different show, six weeks
//     back) means a bare keyword filter with no date window cannot pass by
//     accident.
//   - two newsletters whose bodies say "Kinotickets" mean a free-text query
//     lands on noise, which is what made the original session fail.
//
// Everything seeded is deleted again on exit, so re-runs stay clean.
// Slow + non-deterministic; runs only via `just smoke-test-mcp-agent-type`.

import {
  DAY_MS,
  destroy,
  type Fixture,
  fail,
  inboxId,
  log,
  openSession,
  runAgent,
  runEval,
  seed,
} from './agent-eval-lib.ts'

const SEARCH_TOOL = 'mcp__langmail__search_emails'

const main = async () => {
  const session = await openSession()
  const mailboxId = await inboxId(session)
  // Addressed to the authenticated principal itself: the fixtures are imported
  // straight into that account's Inbox, so anything else would put a recipient
  // in the header that never received the mail.
  const to = session.username

  const now = new Date()
  const daysAgo = (n: number): Date => new Date(now.getTime() - n * DAY_MS)
  const targetReceivedAt = daysAgo(2)

  const fixtures: Record<string, Fixture> = {
    // The target: booked two days out, for a show that ran yesterday. Nothing
    // in the subject says "ticket" or "cinema" — that is the whole point.
    target: {
      body: 'Your seats are reserved. Row 7, seats 12-13. Please arrive ten minutes early.',
      from: 'Lichtspielhaus Mitte <booking@lichtspielhaus-mitte.example>',
      receivedAt: targetReceivedAt,
      subject: 'Booking for Signals from Saturn',
      typeKeyword: '$type:ticket',
    },
    // Same type, wrong date: a bare keyword filter would return this too.
    olderTicket: {
      body: 'Your seats are reserved. Row 2, seat 4.',
      from: 'Lichtspielhaus Mitte <booking@lichtspielhaus-mitte.example>',
      receivedAt: daysAgo(44),
      subject: 'Booking for The Long Quiet',
      typeKeyword: '$type:ticket',
    },
    // Keyword bait: the word a free-text query would reach for.
    baitOne: {
      body: 'Kinotickets zum halben Preis, nur diese Woche! Jetzt sichern.',
      from: 'Wochenpost <newsletter@wochenpost.example>',
      receivedAt: daysAgo(1),
      subject: 'Diese Woche im Kino',
      typeKeyword: '$type:newsletter',
    },
    baitTwo: {
      body: 'Alle Kinotickets im Abo — unser Angebot für Vielseher.',
      from: 'Filmclub <news@filmclub.example>',
      receivedAt: daysAgo(3),
      subject: 'Der Filmclub-Newsletter',
      typeKeyword: '$type:newsletter',
    },
  }

  const seeded: Record<string, string> = {}
  try {
    log('seed fixtures')
    for (const [key, fixture] of Object.entries(fixtures)) {
      seeded[key] = await seed(session, mailboxId, to, fixture)
    }
    process.stdout.write(`  target=${seeded.target} older=${seeded.olderTicket}\n`)

    // Stalwart indexes asynchronously; give the imports a moment to land.
    await Bun.sleep(2000)

    log('run the agent')
    const yesterday = daysAgo(1).toISOString().slice(0, 10)
    const { resultText, toolUses } = runAgent(
      `Show me the cinema tickets of yesterday's show (the showing was on ${yesterday}). ` +
        'Tell me the exact subject of the booking confirmation and its message id.'
    )

    const searches = toolUses.filter((t) => t.name === SEARCH_TOOL)
    process.stdout.write(`  tools called: ${toolUses.map((t) => t.name).join(', ') || '—'}\n`)
    for (const s of searches) {
      process.stdout.write(`  search_emails ${JSON.stringify(s.input)}\n`)
    }

    // 1. One call, not a sequence of speculative keyword searches.
    if (searches.length !== 1) {
      fail(`expected exactly 1 search_emails call, saw ${searches.length}`)
    }
    const [search] = searches
    const input = search?.input ?? {}

    // 2. It filtered by type rather than guessing at words.
    const keywords = Array.isArray(input.keywords) ? (input.keywords as string[]) : []
    if (!keywords.includes('ticket')) {
      fail(`search_emails did not filter on the ticket type: ${JSON.stringify(input)}`)
    }

    // 3. The window is wide enough for a booking lead time — the target's
    //    received date is two days before the show, so a literal "yesterday"
    //    window misses it.
    const after = typeof input.after === 'string' ? Date.parse(input.after) : Number.NaN
    const before = typeof input.before === 'string' ? Date.parse(input.before) : Number.NaN
    if (Number.isNaN(after) || Number.isNaN(before)) {
      fail(`search_emails did not bound the search with after/before: ${JSON.stringify(input)}`)
    }
    const receivedAt = targetReceivedAt.getTime()
    if (!(after <= receivedAt && receivedAt < before)) {
      fail(
        `the after/before window [${input.after}, ${input.before}) does not contain the booking's ` +
          `received date ${targetReceivedAt.toISOString()} — the lead-time guidance did not land`
      )
    }

    // 4. It actually retrieved the target, and the window did its job: the
    //    six-week-old ticket stayed out.
    if (!resultText.includes(seeded.target ?? '')) {
      fail('the seeded booking was not among the returned hits')
    }
    if (resultText.includes(seeded.olderTicket ?? '')) {
      fail('the older ticket was returned too — the date window was not load-bearing')
    }

    process.stdout.write('\n✅ type-filter agent eval passed\n')
  } finally {
    log('clean up seeded fixtures')
    await destroy(session, Object.values(seeded))
  }
}

await runEval(main)
