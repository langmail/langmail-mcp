// Agent eval for forward_message (issue #1201): "Forward the invoice from the
// landlord to my accountant accountant@example.com, say 'for the tax return'".
//
// A right answer delivers exactly one message to that address that carries the
// invoice PDF, the original's From and Date, and the note. Without a forward
// tool, the agent rebuilds the message by hand over get_email + create_draft +
// send_draft, and the headers and formatting are whatever it types.
//
// Two near-misses run first, in fresh sessions:
//   - "draft a forward … for me to check" must stage a draft and send nothing;
//   - "reply to the landlord" must not pick forward_message.
// The forward request runs last, so the `result:` line counts its calls.
//
// Everything seeded, staged or sent is deleted again on exit, so re-runs stay
// clean. Slow + non-deterministic; run it by hand per
// docs/guides/local-development.md § Agent trajectory evals.

import { readFileSync } from 'node:fs'

import {
  DAY_MS,
  destroy,
  type Fixture,
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

const TOOL = 'mcp__langmail__'
const ACCOUNTANT = 'accountant@example.com'
const LANDLORD = 'landlord@hausverwaltung-berger.example'
const NOTE = 'for the tax return'
const PDF_NAME = 'Invoice-2026-11.pdf'

const pdfBase64 = readFileSync(new URL('../src/attachments/fixtures/sample.pdf', import.meta.url)).toString('base64')

interface Part {
  name?: string | null
  partId?: string | null
  type?: string | null
}

interface Mail {
  attachments?: Part[] | null
  bodyValues?: Record<string, { value: string }> | null
  id: string
  keywords?: Record<string, boolean> | null
  threadId?: string | null
  to?: { email: string }[] | null
}

const mailboxIds = async (session: Session): Promise<Record<string, string>> => {
  const json = await jmapCall(session, [
    ['Mailbox/get', { accountId: session.accountId, properties: ['id', 'role'] }, '0'],
  ])
  const list = (json.methodResponses?.[0]?.[1]?.list ?? []) as { id: string; role?: string | null }[]
  return Object.fromEntries(list.flatMap((m) => (m.role ? [[m.role.toLowerCase(), m.id]] : [])))
}

const mailIn = async (session: Session, mailboxId: string): Promise<Mail[]> => {
  const json = await jmapCall(session, [
    ['Email/query', { accountId: session.accountId, filter: { inMailbox: mailboxId }, limit: 100 }, '0'],
    [
      'Email/get',
      {
        '#ids': { name: 'Email/query', path: '/ids', resultOf: '0' },
        accountId: session.accountId,
        fetchAllBodyValues: true,
        properties: ['id', 'to', 'attachments', 'bodyValues', 'keywords', 'threadId'],
      },
      '1',
    ],
  ])
  return (json.methodResponses?.[1]?.[1]?.list ?? []) as Mail[]
}

const calls = (toolUses: { name: string }[]): string => toolUses.map((t) => t.name.replace(TOOL, '')).join(', ') || '—'

const main = async () => {
  const session = await openSession()
  const inbox = await inboxId(session)
  const roles = await mailboxIds(session)
  const sentId = roles.sent ?? fail('account has no Sent mailbox')
  const draftsId = roles.drafts ?? fail('account has no Drafts mailbox')

  const sentAt = new Date(Date.now() - 3 * DAY_MS)
  sentAt.setUTCHours(9, 30, 0, 0)
  const fixtures: Record<string, Fixture> = {
    // The target: an HTML invoice with the PDF attached.
    invoice: {
      attachments: [{ base64: pdfBase64, name: PDF_NAME, type: 'application/pdf' }],
      body:
        '<html><body><p>Dear tenant,</p><p>please find attached the invoice for the <b>November</b> rent ' +
        'and service charges.</p><p>Kind regards,<br>Berger property management</p></body></html>',
      contentType: 'text/html',
      from: `Berger Hausverwaltung <${LANDLORD}>`,
      receivedAt: sentAt,
      subject: 'Invoice 2026-11: rent and service charges',
    },
    // Bait: another invoice, from someone else.
    bait: {
      attachments: [{ base64: pdfBase64, name: 'Stromrechnung.pdf', type: 'application/pdf' }],
      body: 'Your electricity bill for October is attached.',
      from: 'Stadtwerke <billing@stadtwerke.example>',
      receivedAt: new Date(sentAt.getTime() + DAY_MS),
      subject: 'Your electricity bill',
    },
  }

  const seeded: Record<string, string> = {}
  const before = new Set([...(await mailIn(session, sentId)), ...(await mailIn(session, draftsId))].map((m) => m.id))
  const fresh = async (mailboxId: string): Promise<Mail[]> =>
    (await mailIn(session, mailboxId)).filter((m) => !before.has(m.id))
  try {
    log('seed fixtures')
    for (const [key, fixture] of Object.entries(fixtures)) {
      seeded[key] = await seed(session, inbox, session.username, fixture)
    }
    await Bun.sleep(2000)

    log('near-miss: draft a forward for review')
    const drafted = runAgent(
      `Draft a forward of the invoice from my landlord to my accountant ${ACCOUNTANT} for me to check. Do not send it.`
    )
    process.stdout.write(`  tools called: ${calls(drafted.toolUses)}\n`)
    const sends = drafted.toolUses.filter((t) => [`${TOOL}forward_message`, `${TOOL}send_draft`].includes(t.name))
    if (sends.length > 0 || (await fresh(sentId)).length > 0) {
      fail('asked for a draft to check, the agent sent mail')
    }
    const staged = (await fresh(draftsId)).filter((m) => m.to?.some((a) => a.email === ACCOUNTANT))
    if (staged.length === 0) {
      fail('asked for a draft to check, the agent staged none for the accountant')
    }
    await destroy(
      session,
      (await fresh(draftsId)).map((m) => m.id)
    )

    log('near-miss: reply to the landlord')
    const replied = runAgent(
      "Reply to my landlord's invoice email: thanks, I'll pay by the end of the week. Send it, no need to check with me."
    )
    process.stdout.write(`  tools called: ${calls(replied.toolUses)}\n`)
    if (replied.toolUses.some((t) => t.name === `${TOOL}forward_message`)) {
      fail('asked to reply, the agent called forward_message')
    }
    await destroy(
      session,
      [...(await fresh(sentId)), ...(await fresh(draftsId))].map((m) => m.id)
    )

    log('run the agent: forward')
    const { resultText, toolUses } = runAgent(
      `Forward the invoice from the landlord to my accountant ${ACCOUNTANT}, say '${NOTE}'. ` +
        "Send it right away, I've confirmed the recipient."
    )
    process.stdout.write(`  tools called: ${calls(toolUses)}\n`)

    const out = (await fresh(sentId)).filter((m) => m.to?.some((a) => a.email === ACCOUNTANT))
    if (out.length !== 1) {
      // The agent's last words say why: a question back, a wrong pick, an error.
      process.stdout.write(`  agent's answer: ${resultText.trim().split('\n').at(-1)?.slice(0, 600) ?? ''}\n`)
      fail(`expected one message to ${ACCOUNTANT} in Sent, found ${out.length}`)
    }
    const [mail] = out
    const body = Object.values(mail?.bodyValues ?? {})
      .map((v) => v.value)
      .join('\n')
    const day = sentAt.getUTCDate()
    const month = sentAt.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })
    const isoDate = sentAt.toISOString().slice(0, 10)
    const checks: [string, boolean][] = [
      ['the invoice PDF', (mail?.attachments ?? []).some((p) => p.name === PDF_NAME && p.type === 'application/pdf')],
      ['the note', body.toLowerCase().includes(NOTE)],
      ["the original's From", body.includes(LANDLORD)],
      [
        "the original's Date",
        body.includes(`${day} ${month}`) || body.includes(`${month} ${day}`) || body.includes(isoDate),
      ],
    ]
    const missing = checks.filter(([, ok]) => !ok).map(([what]) => what)
    if (missing.length > 0) {
      fail(`the forward is missing: ${missing.join(', ')}`)
    }
    // Informational: whether it threads with the original and marked it.
    const original = (await mailIn(session, inbox)).find((m) => m.id === seeded.invoice)
    process.stdout.write(
      `  same thread as the original: ${mail?.threadId === original?.threadId} · original $forwarded: ${original?.keywords?.$forwarded === true}\n`
    )
  } finally {
    log('clean up seeded, staged and sent mail')
    await destroy(session, [
      ...Object.values(seeded),
      ...(await fresh(sentId)).map((m) => m.id),
      ...(await fresh(draftsId)).map((m) => m.id),
    ])
  }
}

await runEval(main)
