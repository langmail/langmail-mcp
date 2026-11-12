// Agent eval for contact roles (#1213): "Write to my lawyer about the new
// lease." The user said earlier that Robin Fairweather is their lawyer, so
// Robin's card carries the role `lawyer`. The right answer is a draft to
// robin@fairweather-law.example, with the person resolved by one contact
// lookup and no mail search before it. Mail searches after it, for the
// lease itself, are the agent's own call and do not fail the run.
//
// Decoys: the brief's contact named Lawrence and front desk at
// `lawhouse.example`, plus two that "lawyer" does match without the role, a
// referral service by organization and an inbox at `lawyerhouse.example`,
// so only a role ranked first puts Robin on top. No mail from Robin is seeded: an old
// thread would invite a reply in it, which takes a mail search whether or
// not the role resolved the person.
//
// Everything seeded, and the draft the agent stages, is deleted on exit.
// Run per docs/guides/local-development.md § Agent trajectory evals.

import {
  allCards,
  createCards,
  destroy,
  destroyCards,
  draftsTo,
  fail,
  log,
  openContacts,
  openSession,
  runAgent,
  runEval,
} from './agent-eval-lib.ts'

const LAWYER = 'robin@fairweather-law.example'
const DRAFT_TOOL = 'mcp__langmail__create_draft'
const CONTACT_SEARCH_TOOL = 'mcp__langmail__search_contacts'
const LANGMAIL = 'mcp__langmail__'
const LEASE = /lease/iu

const main = async () => {
  const session = await openSession()
  const contacts = await openContacts(session)
  const before = new Set((await allCards(contacts)).map((c) => c.id))

  let cardIds: string[] = []
  try {
    log('seed contacts')
    cardIds = await createCards(contacts, [
      {
        emails: { e0: { address: LAWYER } },
        name: { full: 'Robin Fairweather' },
        organizations: { o0: { name: 'Fairweather Law' } },
        titles: { r0: { kind: 'role', name: 'lawyer' } },
      },
      { emails: { e0: { address: 'lawrence@example.org' } }, name: { full: 'Lawrence Example' } },
      { emails: { e0: { address: 'frontdesk@lawhouse.example' } }, name: { full: 'Front Desk' } },
      {
        emails: { e0: { address: 'intake@referrals.example' } },
        name: { full: 'Alex Intake' },
        organizations: { o0: { name: 'Lawyer Referral Service' } },
      },
      { emails: { e0: { address: 'info@lawyerhouse.example' } }, name: { full: 'Info Desk' } },
    ])
    await Bun.sleep(2000)

    log('run the agent')
    const { toolUses } = runAgent('Write to my lawyer about the new lease.')
    const langmail = toolUses.filter((t) => t.name.startsWith(LANGMAIL))
    process.stdout.write(`  tools called: ${langmail.map((t) => t.name).join(', ') || '—'}\n`)

    const drafts = toolUses.filter((t) => t.name === DRAFT_TOOL)
    const toLawyer = drafts.some((d) =>
      JSON.stringify(d.input.to ?? '')
        .toLowerCase()
        .includes(LAWYER)
    )
    if (!toLawyer) {
      fail(`no draft to ${LAWYER}: ${JSON.stringify(drafts.map((d) => d.input))}`)
    }
    const subjectAndBody = drafts.map((d) => `${d.input.subject ?? ''} ${d.input.body ?? ''}`).join(' ')
    if (!LEASE.test(subjectAndBody)) {
      fail('the draft is not about the lease')
    }
    // The person is resolved before any mail search: the first Langmail call
    // is the one contact lookup, and no second lookup follows. A mail search
    // after it looks for the lease, not the person.
    const lookups = langmail.filter((t) => t.name === CONTACT_SEARCH_TOOL).length
    if (langmail[0]?.name !== CONTACT_SEARCH_TOOL || lookups !== 1) {
      fail(`expected one search_contacts call first, saw ${langmail.map((t) => t.name).join(', ')}`)
    }
    process.stdout.write('\n✅ contact-role agent eval passed\n')
  } finally {
    log('clean up')
    const recipients = [
      LAWYER,
      'lawrence@example.org',
      'frontdesk@lawhouse.example',
      'intake@referrals.example',
      'info@lawyerhouse.example',
    ]
    // One query at a time: Stalwart caps concurrent requests per account.
    const drafts: string[] = []
    for (const recipient of recipients) {
      drafts.push(...(await draftsTo(session, recipient)))
    }
    await destroy(session, drafts)
    const added = (await allCards(contacts)).map((c) => c.id).filter((id) => !before.has(id))
    await destroyCards(contacts, [...new Set([...cardIds, ...added])])
  }
}

await runEval(main)
