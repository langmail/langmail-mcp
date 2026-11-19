// Agent eval for the self-hosted contact search (#1354): "What is Robin
// Fairweather's email address?" Robin has written to the user twice and has
// no card, and on the self-hosted server nothing collects one from mail. The
// right answer is Robin's address from one search_contacts call and no other
// Langmail call, told to the user as not saved. The follow-up "Save her as my
// lawyer", in the same conversation, is a create_contact call with the role,
// which leaves a card for Robin holding `lawyer`.
//
// A colleague of Robin's is on Cc of one mail, so a fallback that returned
// everyone on a matching message would show two people.
//
// Run against the self-hosted server on the dev Stalwart, per
// docs/evals.md:
//
//   AGENT_EVAL_MCP_URL=http://127.0.0.1:8095/mcp AGENT_EVAL_MCP_TOKEN=… \
//   AGENT_EVAL_STALWART_USERNAME=… AGENT_EVAL_STALWART_PASSWORD=… \
//   STALWART_PUBLIC_URL=http://127.0.0.1:9090 bun run smoke:agent-contact-from-mail
//
// Everything seeded, and the card the agent creates, is deleted on exit.
// Slow and non-deterministic.

import {
  allCards,
  type CardRecord,
  DAY_MS,
  destroy,
  destroyCards,
  fail,
  inboxId,
  log,
  openContacts,
  openSession,
  runAgent,
  runEval,
  seed,
} from './agent-eval-lib.ts'

const ROBIN = 'robin@fairweather-law.example'
const LANGMAIL = 'mcp__langmail__'
const CONTACT_SEARCH_TOOL = 'mcp__langmail__search_contacts'
const CREATE_TOOL = 'mcp__langmail__create_contact'
// How an answer says the address is not a saved contact.
const NOT_SAVED =
  /\b(not|isn['’]t|aren['’]t)\b[^.]{0,40}\b(saved|stored|a contact|in your (contacts|address book))|unsaved|no (saved )?contact/iu

const holdsRobin = (card: CardRecord): boolean =>
  Object.values(card.emails ?? {}).some((e) => e.address.toLowerCase() === ROBIN)

const main = async () => {
  const session = await openSession()
  const contacts = await openContacts(session)
  const mailboxId = await inboxId(session)
  const before = new Set((await allCards(contacts)).map((c) => c.id))
  if ((await allCards(contacts)).some(holdsRobin)) {
    fail('a card for Robin exists before the run; delete it first')
  }

  const now = Date.now()
  const seeded: string[] = []
  try {
    log('seed two mails from Robin')
    seeded.push(
      await seed(session, mailboxId, session.username, {
        body: 'Please find the draft lease attached for your review. Best, Robin',
        cc: 'Sam Clerk <sam.clerk@fairweather-law.example>',
        from: `Robin Fairweather <${ROBIN}>`,
        receivedAt: new Date(now - 9 * DAY_MS),
        subject: 'Draft lease for review',
      }),
      await seed(session, mailboxId, session.username, {
        body: 'I have made the changes we discussed. Let me know if anything else comes up. Robin',
        from: `Robin Fairweather <${ROBIN}>`,
        receivedAt: new Date(now - 2 * DAY_MS),
        subject: 'Re: Draft lease for review',
      })
    )
    await Bun.sleep(2000)

    log('request 1: the address')
    const ask = runAgent("What is Robin Fairweather's email address?")
    const asked = ask.toolUses.filter((t) => t.name.startsWith(LANGMAIL))
    process.stdout.write(`  request 1 tools called (${asked.length}): ${asked.map((t) => t.name).join(', ') || '—'}\n`)
    process.stdout.write(`  request 1 answer: ${ask.finalText.replace(/\s+/gu, ' ').slice(0, 300)}\n`)
    if (!ask.finalText.toLowerCase().includes(ROBIN)) {
      fail(`the answer does not give ${ROBIN}`)
    }
    if (asked.length !== 1 || asked[0]?.name !== CONTACT_SEARCH_TOOL) {
      fail(`expected one search_contacts call and nothing else, saw ${asked.map((t) => t.name).join(', ')}`)
    }
    if (!NOT_SAVED.test(ask.finalText)) {
      fail('the answer does not say the address is not saved as a contact')
    }

    log('request 2: save her as my lawyer')
    const save = runAgent('Save her as my lawyer.', { resume: ask.sessionId })
    const saved = save.toolUses.filter((t) => t.name.startsWith(LANGMAIL))
    process.stdout.write(`  request 2 tools called (${saved.length}): ${saved.map((t) => t.name).join(', ') || '—'}\n`)
    const creates = save.toolUses.filter((t) => t.name === CREATE_TOOL)
    for (const c of creates) {
      process.stdout.write(`  create_contact ${JSON.stringify(c.input)}\n`)
    }
    const withRole = creates.some((c) =>
      JSON.stringify(c.input.roles ?? [])
        .toLowerCase()
        .includes('lawyer')
    )
    if (!withRole) {
      fail('no create_contact call with the role lawyer')
    }
    const robinCards = (await allCards(contacts)).filter(holdsRobin)
    const hasRole = robinCards.some((c) =>
      Object.values(c.titles ?? {}).some((t) => t.kind === 'role' && t.name.toLowerCase().includes('lawyer'))
    )
    if (robinCards.length !== 1 || !hasRole) {
      fail(`expected one card for Robin holding the role lawyer, found ${robinCards.length}`)
    }
    process.stdout.write('\n✅ contact-from-mail agent eval passed\n')
  } finally {
    log('clean up')
    await destroy(session, seeded)
    const added = (await allCards(contacts)).map((c) => c.id).filter((id) => !before.has(id))
    await destroyCards(contacts, added)
  }
}

await runEval(main, { countAllRuns: true })
