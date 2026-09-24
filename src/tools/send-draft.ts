// send_draft tool — hand a staged draft to the SMTP queue.
//
// This is the one irreversible, externally visible operation on the mail
// surface, and the design leans on that being obvious: a send is only reachable
// from a draft that already exists, so there is always a state the user (or the
// agent) could have inspected between composing and sending.
//
// Two things guard a duplicate send. The structural one needs no cooperation
// from the client: a successful submission moves the message out of Drafts and
// clears `$draft` in the same round-trip (see @langmail/jmap `submission.ts`),
// so a second call finds a message that is no longer a draft and refuses. The
// cooperative one is `idempotencyKey`, which replays the first call's answer
// when the client retries a call whose response it never saw. Both are checked
// inside a reservation taken before either is read (see drafts/send-guard.ts);
// the protocol is model-checked in `spec/SendProtocol.tla`.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { bearerAuthorization, type EmailComposeRecord, type EmailDraft, JmapError } from '@langmail/jmap'

import { type IdempotencyStore } from '../drafts/idempotency.ts'
import { holdSend, reservationRefusal, type SendGuard, type SendHold, type SendSubject } from '../drafts/send-guard.ts'
import { OUTWARD_DESTRUCTIVE } from './annotations.ts'
import {
  countRecipients,
  type DraftToolDeps,
  draftFromRecord,
  formatDraft,
  isDraft,
  MAX_DRAFT_BODY_VALUE_BYTES,
  resolveIdentity,
  unreferencableAttachments,
} from './draft-common.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

// The replay cache is keyed per tool — see drafts/idempotency.ts.
const TOOL_NAME = 'send_draft'

// What a send of `draftId` reserves against. Exported because reply_to_message
// also covers the draft it stages under this subject.
export const sendDraftSubject = (draftId: string): SendSubject => ({ key: draftId, tool: TOOL_NAME })

export const sendDraftInput = z.object({
  draftId: z
    .string()
    .min(1)
    .describe('The draft to send, as returned by the most recent create_draft or update_draft call.'),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Client-chosen key that makes this call safe to retry: a repeat with the same key returns the ' +
        'first call’s answer instead of sending the message a second time. Pass one whenever the call ' +
        'might be retried.'
    ),
})

export type SendDraftArgs = z.infer<typeof sendDraftInput>

export interface SendDraftContext {
  args: SendDraftArgs
  principal: string
  token: string
}

export interface SubmitParams {
  authorization: string
  // The message to send. Already staged in Drafts.
  draftId: string
  // The account's Drafts mailbox — the message leaves it on success. Not
  // nullable: a caller with no Drafts folder has nothing staged to send.
  draftsMailboxId: string
  // The caller's reservation, already covering this draft. submitDraft only
  // marks it unknown when delivery can no longer be ruled out; the caller ends
  // it, after recording its replay, so a retry never sees the reservation gone
  // before the answer it should replay exists.
  hold: SendHold
  identityId: string
  // The account's Sent mailbox, when it has one.
  sentMailboxId?: string
  // Resolved by the caller: the submission call must be the only I/O here, so
  // a transport failure here always means "maybe delivered".
  submissionAccountId: string
}

// Submit a staged draft and report where the message ended up. Shared with
// reply_to_message, which stages its own draft first and then lands here — the
// send half must be identical on both paths or one of them drifts.
export const submitDraft = async (deps: DraftToolDeps, p: SubmitParams): Promise<string> => {
  let submission: Awaited<ReturnType<typeof deps.emailSubmissionCreate>>
  try {
    submission = await deps.emailSubmissionCreate({
      accountId: p.submissionAccountId,
      apiUrl: '',
      authorization: p.authorization,
      draftsMailboxId: p.draftsMailboxId,
      emailId: p.draftId,
      identityId: p.identityId,
      ...(p.sentMailboxId ? { sentMailboxId: p.sentMailboxId } : {}),
    })
  } catch (error) {
    // A JMAP method error means the server answered, and it answered no — so
    // nothing was sent and this stays retryable. Anything else (timeout, reset)
    // may have been accepted with the answer lost: keep the reservation.
    if (!wasRefused(error)) {
      p.hold.markUnknown()
    }
    throw error
  }
  const lines: string[] = []
  if (submission.sendAt) {
    lines.push(`sendAt: ${submission.sendAt}`)
  }
  if (submission.filed) {
    // The message is marked as no longer a draft, so that server-side flag now
    // does the blocking and the reservation has nothing left to protect — the
    // caller releases it, keeping a deliberate later send unaffected.
    lines.push(
      p.sentMailboxId
        ? 'The message is in Sent — read it back with get_email using the messageId above.'
        : 'The message was sent but stayed in Drafts — this account has no Sent folder. Read it back with ' +
            'get_email using the messageId above.'
    )
    return lines.join('\n')
  }
  // Delivered, but the server did not apply the follow-up patch, so the message
  // still looks like an unsent draft. The structural guard is therefore absent:
  // hold the reservation so a retry is refused rather than delivering a second
  // copy, and say so loudly — this is the one state where the usual "it's still a
  // draft, so it can't have been sent" reasoning is wrong.
  p.hold.markUnknown()
  lines.push(
    'WARNING: the message WAS sent, but the mailbox could not be updated, so it still appears in Drafts and ' +
      'still looks unsent. Do NOT send it again — that would deliver a second copy. Tell the user it went out ' +
      'and that the stale draft can be deleted by hand.'
  )
  return lines.join('\n')
}

// Whether a submission error is the server's "no" — nothing was sent — rather
// than a transport failure that says nothing about delivery.
export const wasRefused = (error: unknown): boolean => error instanceof JmapError && error.errorType !== undefined

// The report both send paths return: the id of the mail that has now gone, the
// message as it was sent, and where it landed. The Email id survives the move
// out of Drafts, so a draft's id is the sent message's id — which is what makes
// "read back what you just sent" a get_email call rather than a search.
export const formatSent = (
  heading: string,
  p: {
    draft: EmailDraft
    messageId: string
    outcome: string
    threadId: string | null
    // Files the sent message carried that the composable model cannot express
    // (see `unreferencableAttachments`). They went out with it, so a report that
    // omitted them would understate what was just delivered — and that report is
    // the record of an action nobody can take back.
    unreferencable?: string[]
  }
): string =>
  [
    heading,
    `messageId: ${p.messageId}`,
    formatDraft(p.draft, { threadId: p.threadId, ...(p.unreferencable ? { unreferencable: p.unreferencable } : {}) }),
    p.outcome,
  ].join('\n')

// Resolve the draft and the identity it goes out as, or the reason it can't be
// sent. A missing draft and an already-sent one are different failures and the
// agent needs to tell them apart: one is a wrong id, the other means the mail
// has already gone.
const loadSendableDraft = async (
  deps: DraftToolDeps,
  p: { accountId: string; authorization: string; draftId: string }
): Promise<{ error: ToolResult } | { record: EmailComposeRecord }> => {
  const record = await deps.emailComposeGet({
    accountId: p.accountId,
    apiUrl: '',
    authorization: p.authorization,
    id: p.draftId,
    maxBodyValueBytes: MAX_DRAFT_BODY_VALUE_BYTES,
  })
  if (!record) {
    return {
      error: errorResult(
        `Draft not found: ${p.draftId}. Nothing was sent. If it was edited, use the draftId that ` +
          'update_draft returned — editing a draft changes its id.'
      ),
    }
  }
  if (!isDraft(record)) {
    return {
      error: errorResult(
        `${p.draftId} is no longer a draft — it has already been sent. Nothing was sent again. ` +
          'Read it back with get_email.'
      ),
    }
  }
  // create_draft refuses a recipientless draft at staging time, but this tool
  // sends any draft in the folder — including one the user composed in Langmail
  // and left unaddressed. Without this, the empty roster reaches the server as a
  // submission with nothing to derive an envelope from, and the agent gets a raw
  // JMAP error instead of the one fact it can act on.
  if (countRecipients(record) === 0) {
    return {
      error: errorResult(
        `Draft ${p.draftId} has no recipients, so it cannot be sent. Nothing was sent. Add them with ` +
          'update_draft, then send the draftId it returns.'
      ),
    }
  }
  return { record }
}

export const sendDraft = async (
  deps: DraftToolDeps,
  replays: IdempotencyStore<string>,
  guard: SendGuard,
  ctx: SendDraftContext
): Promise<ToolResult> => {
  const { args, principal } = ctx
  // The replay lookup and the reservation run in one synchronous step, before
  // the first await: a key that already has an answer gets it back whatever
  // state the reservation was left in (an unfiled send leaves it `unknown`),
  // and anything else reserves before the draft is read. A retry passes the
  // same draftId, so it is the stable subject here.
  if (args.idempotencyKey) {
    const replayed = replays.lookup(TOOL_NAME, principal, args.idempotencyKey)
    if (replayed) {
      return textResult(
        `${replayed}\n\n(Replayed: idempotencyKey "${args.idempotencyKey}" was already used — the message was NOT sent again.)`
      )
    }
  }
  const subject = sendDraftSubject(args.draftId)
  const taken = holdSend(guard, principal, subject)
  if ('refused' in taken) {
    return errorResult(reservationRefusal(subject, taken.refused))
  }
  try {
    return await sendHeld(deps, replays, taken.hold, ctx)
  } finally {
    taken.hold.end()
  }
}

const sendHeld = async (
  deps: DraftToolDeps,
  replays: IdempotencyStore<string>,
  hold: SendHold,
  ctx: SendDraftContext
): Promise<ToolResult> => {
  const { args, principal, token } = ctx
  const authorization = bearerAuthorization(token)
  const accountId = await deps.resolveAccountId(authorization)
  const loaded = await loadSendableDraft(deps, { accountId, authorization, draftId: args.draftId })
  if ('error' in loaded) {
    return loaded.error
  }
  const { record } = loaded

  const mailboxes = await deps.resolveComposeMailboxes(authorization)
  if (!mailboxes.drafts) {
    return errorResult('This account has no Drafts folder, so the draft cannot be sent.')
  }

  // The draft's own From is the sending address: create_draft already validated
  // it against the account's identities, so this only has to map it back to the
  // identity id EmailSubmission needs.
  const sender = record.from?.[0]?.email
  if (!sender) {
    return errorResult(`Draft ${args.draftId} has no sender address, so it cannot be sent.`)
  }
  const submissionAccountId = await deps.resolveSubmissionAccountId(authorization)
  const identity = await resolveIdentity(deps, {
    accountId: submissionAccountId,
    authorization,
    from: sender,
    principal,
  })
  if ('error' in identity) {
    return errorResult(identity.error)
  }

  const outcome = await submitDraft(deps, {
    authorization,
    draftId: args.draftId,
    draftsMailboxId: mailboxes.drafts,
    hold,
    identityId: identity.identityId,
    submissionAccountId,
    ...(mailboxes.sent ? { sentMailboxId: mailboxes.sent } : {}),
  })
  const summary = formatSent('Sent.', {
    draft: draftFromRecord(record),
    messageId: args.draftId,
    outcome,
    threadId: record.threadId ?? null,
    unreferencable: unreferencableAttachments(record),
  })
  if (args.idempotencyKey) {
    replays.record(TOOL_NAME, principal, args.idempotencyKey, summary)
  }
  return textResult(summary)
}

// --- MCP registration ----------------------------------------------------

export const registerSendDraft = (
  server: McpServer,
  deps: DraftToolDeps,
  replays: IdempotencyStore<string>,
  guard: SendGuard,
  getToken: () => string,
  getPrincipal: () => string
): void => {
  server.registerTool(
    'send_draft',
    {
      annotations: OUTWARD_DESTRUCTIVE,
      description:
        'Send a draft. This delivers the message to its recipients and cannot be undone. Confirm the ' +
        'recipients and the body with the user before calling it unless they have already asked for the ' +
        'message to be sent. Sends any draft in the user’s Drafts folder, not only ones you staged — find ' +
        'an existing one with search_emails using `mailbox: "Drafts"`, and read it back with get_draft ' +
        'before sending something you did not write. Use the draftId from the most recent create_draft or ' +
        'update_draft; editing a draft changes its id. Returns the sent message’s id, which get_email can ' +
        'read back. A draft that has already been sent is refused rather than sent twice.',
      inputSchema: sendDraftInput.shape,
      title: 'Send draft',
    },
    (args) => {
      const parsed = sendDraftInput.parse(args)
      return sendDraft(deps, replays, guard, { args: parsed, principal: getPrincipal(), token: getToken() })
    }
  )
}
