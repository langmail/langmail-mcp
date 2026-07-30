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
// when the client retries a call whose response it never saw.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { bearerAuthorization, type EmailComposeRecord, type EmailDraft, JmapError } from '@langmail/jmap'

import { type IdempotencyStore } from '../drafts/idempotency.ts'
import { type SendGuard, type SendSubject } from '../drafts/send-guard.ts'
import { OUTWARD_DESTRUCTIVE } from './annotations.ts'
import {
  countRecipients,
  type DraftToolDeps,
  draftFromRecord,
  formatDraft,
  isDraft,
  MAX_DRAFT_BODY_VALUE_BYTES,
  resolveIdentity,
} from './draft-common.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

// The replay cache is keyed per tool — see drafts/idempotency.ts.
const TOOL_NAME = 'send_draft'

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
  // Guards the window between "is it still a draft?" and the submission landing.
  guard: SendGuard
  identityId: string
  principal: string
  // The account's Sent mailbox, when it has one.
  sentMailboxId?: string
  // What the reservation is taken against — must be identical on a retry of the
  // same logical send, which is not always the draft id. See send-guard.ts.
  subject: SendSubject
}

// Submit a staged draft and report where the message ended up. Shared with
// reply_to_message, which stages its own draft first and then lands here — the
// send half must be identical on both paths or one of them drifts.
export const submitDraft = async (deps: DraftToolDeps, p: SubmitParams): Promise<{ error: string } | string> => {
  const held = p.guard.reserve(p.principal, p.subject)
  if (held) {
    return {
      error:
        held.state === 'in_flight'
          ? `A send of ${p.subject.key} is already in progress. Nothing was sent by this call. Wait, then read ` +
            'the message back with get_email to see whether it went out.'
          : `An earlier send of ${p.subject.key} failed without saying whether the message went out, so it was ` +
            'NOT sent again — a second attempt could deliver a duplicate. Read it back with get_email, or check ' +
            "the user's Sent folder, before deciding.",
    }
  }

  let submission: Awaited<ReturnType<typeof deps.emailSubmissionCreate>>
  try {
    submission = await deps.emailSubmissionCreate({
      accountId: await deps.resolveSubmissionAccountId(p.authorization),
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
    // may have been accepted with the answer lost: hold the reservation.
    if (error instanceof JmapError && error.errorType !== undefined) {
      p.guard.release(p.principal, p.subject)
    } else {
      p.guard.markUnknown(p.principal, p.subject)
    }
    throw error
  }
  const lines: string[] = []
  if (submission.sendAt) {
    lines.push(`sendAt: ${submission.sendAt}`)
  }
  if (submission.filed) {
    // The message is marked as no longer a draft, so that server-side flag now
    // does the blocking and the reservation has nothing left to protect —
    // releasing it keeps a deliberate later send of another draft unaffected.
    p.guard.release(p.principal, p.subject)
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
  p.guard.markUnknown(p.principal, p.subject)
  lines.push(
    'WARNING: the message WAS sent, but the mailbox could not be updated, so it still appears in Drafts and ' +
      'still looks unsent. Do NOT send it again — that would deliver a second copy. Tell the user it went out ' +
      'and that the stale draft can be deleted by hand.'
  )
  return lines.join('\n')
}

// The report both send paths return: the id of the mail that has now gone, the
// message as it was sent, and where it landed. The Email id survives the move
// out of Drafts, so a draft's id is the sent message's id — which is what makes
// "read back what you just sent" a get_email call rather than a search.
export const formatSent = (
  heading: string,
  p: { draft: EmailDraft; messageId: string; outcome: string; threadId: string | null }
): string =>
  [heading, `messageId: ${p.messageId}`, formatDraft(p.draft, { threadId: p.threadId }), p.outcome].join('\n')

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
    // Which remedy to name depends on the attachments: update_draft refuses an
    // attached draft outright, so pointing there would send the agent into a
    // call that cannot succeed.
    const remedy =
      (record.attachments ?? []).length > 0
        ? 'This draft has attachments, so it has to be addressed in Langmail — update_draft cannot edit it.'
        : 'Add them with update_draft, then send the draftId it returns.'
    return {
      error: errorResult(`Draft ${p.draftId} has no recipients, so it cannot be sent. Nothing was sent. ${remedy}`),
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
  const { args, principal, token } = ctx
  if (args.idempotencyKey) {
    const replayed = replays.lookup(TOOL_NAME, principal, args.idempotencyKey)
    if (replayed) {
      return textResult(
        `${replayed}\n\n(Replayed: idempotencyKey "${args.idempotencyKey}" was already used — the message was NOT sent again.)`
      )
    }
  }

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
  const identity = await resolveIdentity(deps, {
    accountId: await deps.resolveSubmissionAccountId(authorization),
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
    guard,
    identityId: identity.identityId,
    principal,
    // A retry passes the same draftId, so it is the stable subject here.
    subject: { key: args.draftId, tool: TOOL_NAME },
    ...(mailboxes.sent ? { sentMailboxId: mailboxes.sent } : {}),
  })
  if (typeof outcome !== 'string') {
    return errorResult(outcome.error)
  }
  const summary = formatSent('Sent.', {
    draft: draftFromRecord(record),
    messageId: args.draftId,
    outcome,
    threadId: record.threadId ?? null,
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
