// Agent eval for drafts written in Apple Mail: such a draft is
// multipart/alternative with an empty text/plain part and the whole message in
// text/html. Seeded that way, the user asks what is waiting in their drafts and
// what the draft to Sam says. A right answer tells them the contract is
// attached and they meet Monday, and never calls the draft empty; it takes one
// list_drafts for the first question and at most list_drafts plus get_draft
// for the second.
//
// Everything seeded, and any draft the agent staged to Sam, is deleted on exit.

import {
  DAY_MS,
  destroy,
  draftsTo,
  fail,
  log,
  mailboxIdByRole,
  openSession,
  runAgent,
  runEval,
  seed,
} from './agent-eval-lib.ts'

const SAM = 'sam@example.com'
// Calls the draft itself empty. The body line's own "text part blank" is a
// fair thing to repeat, so a mention of the blank part alone is not a fail.
const EMPTY_RE =
  /\b(?:draft|it|message|body)(?: is|'s| seems| appears)(?: to be)? (?:empty|blank)\b|\(empty\)|\bno (?:body|content)\b/iu

const judge = (question: string, maxCalls: number): void => {
  log(`ask: ${question}`)
  const { finalText, toolUses } = runAgent(question)
  const calls = toolUses.filter((t) => t.name.startsWith('mcp__langmail__')).map((t) => t.name)
  process.stdout.write(`  tools called: ${calls.join(', ') || '—'}\n  answer: ${finalText.replace(/\s+/gu, ' ')}\n`)
  const answer = finalText.toLowerCase()
  if (!(answer.includes('contract') && answer.includes('monday'))) {
    fail(`"${question}": the answer does not say the contract is attached and they meet Monday`)
  }
  if (EMPTY_RE.test(finalText)) {
    fail(`"${question}": the answer calls the draft empty`)
  }
  if (calls.length > maxCalls) {
    fail(`"${question}": ${calls.length} Langmail calls, at most ${maxCalls} expected`)
  }
}

const main = async () => {
  const session = await openSession()
  const draftsId = await mailboxIdByRole(session, 'drafts')

  const seeded: string[] = []
  try {
    log('seed an Apple Mail draft')
    seeded.push(
      await seed(session, draftsId, SAM, {
        body: '',
        draft: true,
        from: session.username,
        htmlAlternative:
          '<html><body><div>Hi Sam,</div><div>the contract is attached, see you Monday.</div></body></html>',
        receivedAt: new Date(Date.now() - DAY_MS / 24),
        subject: 'Contract',
      })
    )
    // Stalwart indexes asynchronously; give the import a moment to land.
    await Bun.sleep(2000)

    judge("What's waiting in my drafts?", 1)
    judge('What does my draft to Sam say?', 2)

    process.stdout.write('\n✅ Apple Mail draft agent eval passed\n')
  } finally {
    log('clean up')
    await destroy(session, [...new Set([...seeded, ...(await draftsTo(session, SAM))])])
  }
}

await runEval(main, { countAllRuns: true })
