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

import { bearerAuthorization, type EmailComposeRecord, type EmailDraft } from '@langmail/jmap'

import { type IdempotencyStore } from '../drafts/idempotency.ts'
import { OUTWARD_DESTRUCTIVE } from './annotations.ts'
import {
  type DraftToolDeps,
  draftFromRecord,
  formatDraft,
  isDraft,
  MAX_DRAFT_BODY_VALUE_BYTES,
  resolveIdentity,
} from './draft-common.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

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
  identityId: string
  // The account's Sent mailbox, when it has one.
  sentMailboxId?: string
}

// Submit a staged draft and report where the message ended up. Shared with
// reply_to_message, which stages its own draft first and then lands here — the
// send half must be identical on both paths or one of them drifts.
export const submitDraft = async (deps: DraftToolDeps, p: SubmitParams): Promise<string> => {
  const submission = await deps.emailSubmissionCreate({
    accountId: await deps.resolveSubmissionAccountId(p.authorization),
    apiUrl: '',
    authorization: p.authorization,
    draftsMailboxId: p.draftsMailboxId,
    emailId: p.draftId,
    identityId: p.identityId,
    ...(p.sentMailboxId ? { sentMailboxId: p.sentMailboxId } : {}),
  })
  const lines = p.sentMailboxId
    ? ['The message is in Sent — read it back with get_email using the messageId above.']
    : [
        'The message was sent but stayed in Drafts — this account has no Sent folder. Read it back with ' +
          'get_email using the messageId above.',
      ]
  if (submission.sendAt) {
    lines.unshift(`sendAt: ${submission.sendAt}`)
  }
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
  return { record }
}

export const sendDraft = async (
  deps: DraftToolDeps,
  replays: IdempotencyStore<string>,
  ctx: SendDraftContext
): Promise<ToolResult> => {
  const { args, principal, token } = ctx
  if (args.idempotencyKey) {
    const replayed = replays.lookup(principal, args.idempotencyKey)
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
    identityId: identity.identityId,
    ...(mailboxes.sent ? { sentMailboxId: mailboxes.sent } : {}),
  })
  const summary = formatSent('Sent.', {
    draft: draftFromRecord(record),
    messageId: args.draftId,
    outcome,
    threadId: record.threadId ?? null,
  })
  if (args.idempotencyKey) {
    replays.record(principal, args.idempotencyKey, summary)
  }
  return textResult(summary)
}

// --- MCP registration ----------------------------------------------------

export const registerSendDraft = (
  server: McpServer,
  deps: DraftToolDeps,
  replays: IdempotencyStore<string>,
  getToken: () => string,
  getPrincipal: () => string
): void => {
  server.registerTool(
    'send_draft',
    {
      annotations: OUTWARD_DESTRUCTIVE,
      description:
        'Send a draft that create_draft staged. This delivers the message to its recipients and cannot be ' +
        'undone. Confirm the recipients and the body with the user before calling it unless they have ' +
        'already asked for the message to be sent. Use the draftId from the most recent create_draft or ' +
        'update_draft — editing a draft changes its id. Returns the sent message’s id, which get_email ' +
        'can read back. A draft that has already been sent is refused rather than sent twice.',
      inputSchema: sendDraftInput.shape,
      title: 'Send draft',
    },
    (args) => {
      const parsed = sendDraftInput.parse(args)
      return sendDraft(deps, replays, { args: parsed, principal: getPrincipal(), token: getToken() })
    }
  )
}
