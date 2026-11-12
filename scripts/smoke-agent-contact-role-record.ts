// Agent eval for recording a contact role (#1213): the user says "Robin
// Fairweather (robin@fairweather-law.example) is my lawyer." Robin is
// already a contact. The right answer stores the role `lawyer` on that
// existing card, with no second card for Robin.
//
// Everything seeded is deleted on exit.
// Run per docs/guides/local-development.md § Agent trajectory evals.

import {
  allCards,
  type CardRecord,
  createCards,
  destroyCards,
  fail,
  log,
  openContacts,
  openSession,
  runAgent,
  runEval,
} from './agent-eval-lib.ts'

const LAWYER = 'robin@fairweather-law.example'
const LANGMAIL = 'mcp__langmail__'

const holdsLawyer = (card: CardRecord): boolean =>
  Object.values(card.emails ?? {}).some((e) => e.address.toLowerCase() === LAWYER)

const main = async () => {
  const session = await openSession()
  const contacts = await openContacts(session)
  const before = new Set((await allCards(contacts)).map((c) => c.id))

  let robinId = ''
  try {
    log('seed Robin without a role')
    ;[robinId = ''] = await createCards(contacts, [
      { emails: { e0: { address: LAWYER } }, name: { full: 'Robin Fairweather' } },
    ])
    await Bun.sleep(2000)

    log('run the agent')
    const { toolUses } = runAgent(`Robin Fairweather (${LAWYER}) is my lawyer.`)
    const langmail = toolUses.filter((t) => t.name.startsWith(LANGMAIL))
    process.stdout.write(`  tools called: ${langmail.map((t) => t.name).join(', ') || '—'}\n`)

    const robins = (await allCards(contacts)).filter(holdsLawyer)
    if (robins.length !== 1) {
      fail(`expected one contact holding ${LAWYER}, found ${robins.length}`)
    }
    const [robin] = robins
    if (robin?.id !== robinId) {
      fail('the role landed on a new card, not on Robin’s existing one')
    }
    const roles = Object.values(robin?.titles ?? {})
      .filter((t) => t.kind === 'role')
      .map((t) => t.name.toLowerCase())
    if (!roles.includes('lawyer')) {
      fail(`Robin's card carries no role "lawyer" (titles: ${JSON.stringify(robin?.titles ?? {})})`)
    }
    process.stdout.write('\n✅ contact-role-record agent eval passed\n')
  } finally {
    log('clean up')
    const added = (await allCards(contacts)).map((c) => c.id).filter((id) => !before.has(id))
    await destroyCards(contacts, [...new Set([robinId, ...added].filter(Boolean))])
  }
}

await runEval(main)
