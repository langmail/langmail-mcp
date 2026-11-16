// Agent eval for search_contacts on a large address book (#1249), one of two
// requests per run, picked by the first argument:
//
// - `address`: "What's Henrike Wolters' postal address?" Her card has no
//   email address and sits past position 250 of a 1,000-card book. The right
//   answer is her street address; the agent never says she is not in the
//   contacts.
// - `alex`: "Email Alex from Northwind about Friday." The book holds 80
//   contacts named Alex at Northwind, and the most active of them sits past
//   the 50th. The right answer asks which Alex is meant, names the most
//   active one before any other, says there are 80, and stages no draft.
//
// Every card seeded, and any draft the agent stages, is deleted on exit.
// Run per docs/guides/local-development.md § Agent trajectory evals.

import { COLLECTED_NOTE_KEY, collectedNoteEntry, toCardAddress } from '@langmail/contacts'

import {
  allCards,
  type Contacts,
  createCards,
  DAY_MS,
  destroy,
  destroyCards,
  draftsTo,
  fail,
  inboxId,
  log,
  openContacts,
  openSession,
  runAgent,
  runEval,
  seed,
} from './agent-eval-lib.ts'

const BOOK_SIZE = 1000
// Stalwart's default `maxObjectsInSet`.
const SET_BATCH = 500
const HENRIKE_AT = 400
const ALEX_COUNT = 80
const ACTIVE_ALEX_AT = 65
const ACTIVE_ALEX = 'Alex Okafor-Lind'
const NORTHWIND = 'northwind.example'
const DRAFT_TOOL = 'mcp__langmail__create_draft'
const LANGMAIL = 'mcp__langmail__'
const STREET = /Lindenallee 12/iu
const NOT_FOUND =
  /(not|isn't|is not|wasn't|couldn't|could not)[^.]{0,40}(find|found|in your contacts|in the contacts)/iu
const EIGHTY = /\b80\b|eighty/iu

const SURNAMES = [
  'Achterberg',
  'Brandvold',
  'Castellane',
  'Dunmore',
  'Eskelund',
  'Falkner',
  'Gravenhorst',
  'Hollinger',
  'Ibarrola',
  'Jessop',
  'Kettering',
  'Lindqvist',
  'Morcombe',
  'Nettleford',
  'Ostrander',
  'Pemberly',
  'Quarrington',
  'Rosendahl',
  'Silvermoor',
  'Thornquist',
]
const INITIALS = ['B.', 'J.', 'M.', 'T.']

const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString()

// Mail from the most active Alex, seeded for real so the interaction lines
// on their card hydrate to subjects rather than "(message no longer
// available)", which would send the agent looking for it.
const ACTIVE_MAIL = [
  { daysAgo: 3, subject: 'Supplier review notes' },
  { daysAgo: 10, subject: 'Invoice batch 7' },
  { daysAgo: 17, subject: 'Onboarding checklist' },
]

// The collected history of a contact who writes to the user every week.
const activeHistory = (address: string, mailIds: string[]) => ({
  [COLLECTED_NOTE_KEY]: collectedNoteEntry({
    addresses: { [address]: { confidence: 'confirmed', count: 9, firstSeen: daysAgo(200), lastSeen: daysAgo(3) } },
    interactions: ACTIVE_MAIL.map((m, i) => ({
      channel: 'email' as const,
      date: daysAgo(m.daysAgo),
      direction: 'incoming' as const,
      recordId: mailIds[i] ?? '',
    })),
    source: 'derived',
  }),
})

const ACTIVE_ADDRESS = `alex.okafor-lind@${NORTHWIND}`

const alexCards = (mailIds: string[]): Record<string, unknown>[] =>
  Array.from({ length: ALEX_COUNT }, (_, i) => {
    if (i === ACTIVE_ALEX_AT) {
      return {
        emails: { e0: { address: ACTIVE_ADDRESS } },
        name: { full: ACTIVE_ALEX },
        notes: activeHistory(ACTIVE_ADDRESS, mailIds),
        organizations: { o0: { name: 'Northwind' } },
      }
    }
    const surname = SURNAMES[i % SURNAMES.length] as string
    const initial = INITIALS[Math.floor(i / SURNAMES.length)] as string
    return {
      emails: { e0: { address: `alex.${initial[0]?.toLowerCase()}.${surname.toLowerCase()}@${NORTHWIND}` } },
      name: { full: `Alex ${initial} ${surname}` },
      organizations: { o0: { name: 'Northwind' } },
    }
  })

const fillerCard = (i: number): Record<string, unknown> => ({
  emails: { e0: { address: `person${i}@example.org` } },
  name: { full: `Filler Person${i}` },
})

// 1,000 cards: fillers, Henrike at position 400, the 80 Alexes from 600 on.
const book = (mailIds: string[]): Record<string, unknown>[] => {
  const cards = Array.from({ length: BOOK_SIZE }, (_, i) => fillerCard(i))
  cards[HENRIKE_AT] = {
    addresses: {
      a0: toCardAddress({ city: 'Köln', country: 'DE', label: 'home', postalCode: '50968', street: 'Lindenallee 12' }),
    },
    name: { full: 'Henrike Wolters' },
  }
  cards.splice(600, ALEX_COUNT, ...alexCards(mailIds))
  return cards
}

const seedBook = async (contacts: Contacts, cards: Record<string, unknown>[]): Promise<string[]> => {
  const ids: string[] = []
  // In order, so the positions above hold in the unfiltered query.
  for (let i = 0; i < cards.length; i += SET_BATCH) {
    ids.push(...(await createCards(contacts, cards.slice(i, i + SET_BATCH))))
  }
  return ids
}

const checkAddress = (answer: string) => {
  if (NOT_FOUND.test(answer)) {
    fail(`the agent said Henrike is not in the contacts: ${answer}`)
  }
  if (!STREET.test(answer)) {
    fail(`no street address in the answer: ${answer}`)
  }
}

const checkAlex = (answer: string, drafted: boolean) => {
  if (drafted) {
    fail('the agent staged a draft instead of asking which Alex')
  }
  if (!EIGHTY.test(answer)) {
    fail(`the answer does not say there are 80: ${answer}`)
  }
  const active = answer.indexOf(ACTIVE_ALEX)
  const others = SURNAMES.map((s) => answer.indexOf(s)).filter((at) => at >= 0)
  if (active < 0 || others.some((at) => at < active)) {
    fail(`${ACTIVE_ALEX} is not named first: ${answer}`)
  }
}

const main = async () => {
  const which = process.argv[2]
  if (which !== 'address' && which !== 'alex') {
    throw new Error('usage: smoke-agent-contact-large-book.ts address|alex')
  }
  const session = await openSession()
  const contacts = await openContacts(session)
  const before = new Set((await allCards(contacts)).map((c) => c.id))

  let cardIds: string[] = []
  const mailIds: string[] = []
  const inbox = await inboxId(session)
  try {
    log('seed mail from the most active Alex')
    for (const m of ACTIVE_MAIL) {
      mailIds.push(
        await seed(session, inbox, session.username, {
          body: `See attached notes.\n\n${ACTIVE_ALEX}`,
          from: `${ACTIVE_ALEX} <${ACTIVE_ADDRESS}>`,
          receivedAt: new Date(Date.now() - m.daysAgo * DAY_MS),
          subject: m.subject,
        })
      )
    }
    log(`seed a ${BOOK_SIZE}-card book`)
    cardIds = await seedBook(contacts, book(mailIds))
    await Bun.sleep(2000)
    // The email-agent may have collected the seeded mail into a second card
    // for the active Alex; the request is about exactly 80.
    const alexes = (await allCards(contacts)).filter((c) => c.name?.full?.startsWith('Alex '))
    if (alexes.length !== ALEX_COUNT) {
      throw new Error(`expected ${ALEX_COUNT} Alex cards before the run, found ${alexes.length}`)
    }

    log('run the agent')
    const prompt =
      which === 'address' ? "What's Henrike Wolters' postal address?" : 'Email Alex from Northwind about Friday.'
    const { finalText: answer, toolUses } = runAgent(prompt)
    const langmail = toolUses.filter((t) => t.name.startsWith(LANGMAIL))
    process.stdout.write(`  tools called: ${langmail.map((t) => t.name).join(', ') || '—'}\n`)
    process.stdout.write(`  answer: ${answer.replaceAll('\n', ' ').slice(0, 600)}\n`)

    if (which === 'address') {
      checkAddress(answer)
    } else {
      checkAlex(
        answer,
        toolUses.some((t) => t.name === DRAFT_TOOL)
      )
    }
    process.stdout.write('\n✅ large-book contact eval passed\n')
  } finally {
    log('clean up')
    // One query at a time: Stalwart caps concurrent requests per account.
    const drafts: string[] = [...mailIds]
    for (const card of book(mailIds)) {
      const address = (card.emails as { e0?: { address: string } } | undefined)?.e0?.address
      if (address?.endsWith(NORTHWIND)) {
        drafts.push(...(await draftsTo(session, address)))
      }
    }
    await destroy(session, drafts)
    const added = (await allCards(contacts)).map((c) => c.id).filter((id) => !before.has(id))
    const all = [...new Set([...cardIds, ...added])]
    for (let i = 0; i < all.length; i += SET_BATCH) {
      await destroyCards(contacts, all.slice(i, i + SET_BATCH))
    }
  }
}

await runEval(main)
