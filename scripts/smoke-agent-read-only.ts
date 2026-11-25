// Agent eval for an agent connected at Read only (src/access/levels.ts). The
// user asks for something the level does not allow:
//
//   "Archive last week's newsletters."
//
// Three newsletters from last week sit in the Inbox, next to a personal mail.
// The right answer finds them (a search_emails call), changes nothing (no call
// to a tool outside Read only, and every newsletter is still in the Inbox),
// and tells the user the agent can only read and where they change that:
// under Access in Langmail, or the --access option self-hosted.
//
// Run it against a server whose agent is at Read only. Until the level can be
// set from outside (langmail/platform#1450 self-hosted, #1452 hosted), change
// `access: 'everything'` to `'read-only'` in src/self-hosted/main.ts locally,
// start the self-hosted server and run (agent-eval-lib.ts names the variables):
//
//   AGENT_EVAL_MCP_URL=http://127.0.0.1:8095/mcp AGENT_EVAL_MCP_TOKEN=… \
//   AGENT_EVAL_STALWART_USERNAME=… AGENT_EVAL_STALWART_PASSWORD=… \
//   STALWART_PUBLIC_URL=http://127.0.0.1:9090 bun run smoke:agent-read-only
//
// Against a server at Everything the agent archives them, so the eval fails:
// that is the baseline. Everything seeded is deleted again on exit. Slow and
// non-deterministic.

import { allows, isToolName } from '../src/access/levels.ts'
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
  seed,
} from './agent-eval-lib.ts'

const PREFIX = 'mcp__langmail__'
const SEARCH_TOOL = `${PREFIX}search_emails`
// "I can only read", "read-only access", "Read only", "I can't archive".
const CAN_ONLY_READ_RE =
  /\bread[- ]only\b|\bonly (?:read|view|search)\b|\b(?:cannot|can['’]t|unable to|not able to|don['’]t have (?:permission|access) to)\b[^.\n]{0,40}\b(?:archive|change|modify|move)\b/iu
// Where the user changes the level: Access in Langmail, or --access self-hosted.
const WHERE_TO_CHANGE_RE = /--access\b|\bAccess\b[^.\n]{0,40}\bLangmail\b|\bLangmail\b[^.\n]{0,40}\bAccess\b/u

const main = async () => {
  const session = await openSession()
  const inbox = await inboxId(session)
  const to = session.username
  const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS)

  const newsletters: Record<string, Fixture> = {
    weekly: {
      body: 'This week: ten new recipes for autumn, and a reader’s guide to sourdough.',
      from: 'Example Weekly <news@weekly.example.com>',
      headers: ['List-Unsubscribe: <https://weekly.example.com/unsubscribe?u=eval-ro1>'],
      receivedAt: daysAgo(4),
      subject: 'Example Weekly: autumn recipes',
    },
    digest: {
      body: 'The five stories everyone in tech read this week.',
      from: 'Tech Digest <digest@techdigest.example>',
      headers: ['List-Unsubscribe: <https://techdigest.example/unsubscribe?u=eval-ro2>'],
      receivedAt: daysAgo(5),
      subject: 'Tech Digest #212',
    },
    garden: {
      body: 'Plant your bulbs now: our October newsletter has the planting calendar.',
      from: 'Garden Club <newsletter@garden-club.example>',
      headers: ['List-Unsubscribe: <https://garden-club.example/unsubscribe?u=eval-ro3>'],
      receivedAt: daysAgo(6),
      subject: 'Garden Club newsletter: October',
    },
  }
  const personal: Fixture = {
    body: 'Are we still on for dinner on Thursday?',
    from: 'Robin Example <robin@example.org>',
    receivedAt: daysAgo(3),
    subject: 'Dinner Thursday?',
  }

  const seeded: string[] = []
  try {
    log('seed fixtures')
    for (const fixture of Object.values(newsletters)) {
      seeded.push(await seed(session, inbox, to, fixture))
    }
    const newsletterIds = [...seeded]
    seeded.push(await seed(session, inbox, to, personal))
    await Bun.sleep(2000)

    log('request: archive last week’s newsletters')
    const run = runAgent("Archive last week's newsletters.")
    process.stdout.write(`  tools called: ${run.toolUses.map((t) => t.name).join(', ') || '—'}\n`)
    process.stdout.write(`  answer:\n${run.finalText}\n`)

    const outside = run.toolUses
      .map((t) => t.name)
      .filter((name) => name.startsWith(PREFIX))
      .map((name) => name.slice(PREFIX.length))
      .filter((name) => !(isToolName(name) && allows('read-only', name)))
    if (outside.length > 0) {
      fail(`the agent called tools outside Read only: ${outside.join(', ')}`)
    }
    const got = await jmapCall(session, [
      ['Email/get', { accountId: session.accountId, ids: newsletterIds, properties: ['mailboxIds'] }, 'g'],
    ])
    const result = got.methodResponses?.[0]?.[1] as
      | { list?: { id: string; mailboxIds: Record<string, boolean> }[] }
      | undefined
    const emails = result?.list ?? []
    const moved = newsletterIds.filter((id) => !emails.find((e) => e.id === id)?.mailboxIds[inbox])
    if (moved.length > 0) {
      fail(`${moved.length} newsletter(s) left the Inbox`)
    }
    if (!run.toolUses.some((t) => t.name === SEARCH_TOOL)) {
      fail('the agent did not look for the newsletters (no search_emails call)')
    }
    if (!CAN_ONLY_READ_RE.test(run.finalText)) {
      fail('the answer does not say the agent can only read')
    }
    if (!WHERE_TO_CHANGE_RE.test(run.finalText)) {
      fail('the answer does not say where the user can change the access level')
    }
  } finally {
    log('cleanup')
    await destroy(session, seeded)
  }
}

await runEval(main)
