// Agent eval for preview_email: replays the 2026-07-31 session — "show me
// the cinema tickets of yesterday's show" — and verifies the user-visible
// outcome is a RENDERED email, not a textual description of one.
//
// The proxy for "rendered" is the trajectory: the agent must end the turn by
// calling preview_email on the seeded booking confirmation (that call is
// what makes a host with MCP Apps support draw the email inline), and the
// tool must report an html-source preview. Before this feature the same
// prompt ended in get_email + a paragraph about the ticket — the failure
// this eval exists to catch. (The `claude` CLI itself does not render MCP
// Apps; whether pixels appear is per-host and is verified manually against
// claude.ai. What is assertable here is that the agent chose the rendering
// path at all.)
//
// The fixture is an HTML booking confirmation with an embedded data-URI QR
// image — the document shape the feature was built for. A same-day
// newsletter that merely mentions tickets means "preview whatever matched
// first" fails; the agent has to find the booking, then preview it.
//
// Everything seeded is deleted again on exit, so re-runs stay clean.
// Slow + non-deterministic; runs only via `just smoke-test-mcp-agent-preview`.

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

const PREVIEW_TOOL = 'mcp__langmail__preview_email'

// A 1x1 PNG stands in for the QR code — scannability is a manual check on a
// real host; this eval only needs an image the sanitizer must keep.
const QR_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const ticketHtml = (): string =>
  `<html><body>
<table width="600" cellpadding="12" style="border:1px solid #ddd">
<tr><td><h2>Signals from Saturn</h2>
<p>Screen 3 · Row 7, seats 12–13 · Booking ref LSM-88412</p>
<img src="${QR_DATA_URI}" alt="Entry QR code" width="160" height="160">
<p>Show this code at the door.</p></td></tr>
</table>
</body></html>`

const main = async () => {
  const session = await openSession()
  const mailboxId = await inboxId(session)
  const to = session.username

  const now = new Date()
  const daysAgo = (n: number): Date => new Date(now.getTime() - n * DAY_MS)

  const fixtures: Record<string, Fixture> = {
    // The target: an HTML booking confirmation with the QR embedded.
    target: {
      body: ticketHtml(),
      contentType: 'text/html',
      from: 'Lichtspielhaus Mitte <booking@lichtspielhaus-mitte.example>',
      receivedAt: daysAgo(2),
      subject: 'Booking for Signals from Saturn',
      typeKeyword: '$type:ticket',
    },
    // Same-day bait: mentions tickets, is not one.
    bait: {
      body: 'Kinotickets zum halben Preis, nur diese Woche! Jetzt sichern.',
      from: 'Wochenpost <newsletter@wochenpost.example>',
      receivedAt: daysAgo(1),
      subject: 'Diese Woche im Kino',
      typeKeyword: '$type:newsletter',
    },
  }

  const seeded: Record<string, string> = {}
  try {
    log('seed fixtures')
    for (const [key, fixture] of Object.entries(fixtures)) {
      seeded[key] = await seed(session, mailboxId, to, fixture)
    }
    process.stdout.write(`  target=${seeded.target}\n`)

    // Stalwart indexes asynchronously; give the imports a moment to land.
    await Bun.sleep(2000)

    log('run the agent')
    const yesterday = daysAgo(1).toISOString().slice(0, 10)
    const { resultText, toolUses } = runAgent(
      `Show me the cinema tickets of yesterday's show (the showing was on ${yesterday}).`
    )

    process.stdout.write(`  tools called: ${toolUses.map((t) => t.name).join(', ') || '—'}\n`)

    // 1. The turn went through preview_email — the call that renders.
    const previews = toolUses.filter((t) => t.name === PREVIEW_TOOL)
    if (previews.length === 0) {
      fail('the agent never called preview_email — the user got a description, not a rendered email')
    }

    // 2. …on the booking confirmation, not the newsletter bait.
    if (!previews.some((p) => p.input.id === seeded.target)) {
      fail(`preview_email was not called on the seeded booking (${JSON.stringify(previews.map((p) => p.input))})`)
    }
    if (previews.some((p) => p.input.id === seeded.bait)) {
      fail('preview_email was called on the newsletter bait')
    }

    // 3. The preview actually rendered the HTML part, not the text fallback.
    if (!resultText.includes('"renderSource":"html"')) {
      fail('the preview did not use the html rendering path')
    }

    process.stdout.write('\n✅ preview agent eval passed\n')
  } finally {
    log('clean up seeded fixtures')
    await destroy(session, Object.values(seeded))
  }
}

await runEval(main)
