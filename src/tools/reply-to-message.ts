// reply_to_message tool — answer a message and send the reply in one call.
//
// This is the one-shot counterpart to create_draft(inReplyTo) + send_draft, and
// it exists because the two-step form is the wrong shape for the case where the
// user has already said "reply and tell them yes": staging a draft only to send
// it in the next call adds a turn and a chance to lose the id, without adding an
// inspection point anyone was going to use.
//
// The reply is still written as a draft first — the same Email/set create every
// other composition path uses — and only then submitted. That is not a
// formality: it means the message exists in the mailbox before it is handed to
// the queue, so a failed submission leaves a recoverable draft rather than
// nothing at all.
//
// `replyAll` and explicit recipients are mutually exclusive, and the conflict is
// rejected rather than resolved. "Reply to everyone, but only these people" has
// no defensible reading, and silently picking one is how an agent mails the
// wrong list.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { bearerAuthorization, type EmailComposeRecord, type EmailDraft } from '@langmail/jmap'

import { type IdempotencyStore } from '../drafts/idempotency.ts'
import { OUTWARD_DESTRUCTIVE } from './annotations.ts'
import {
  type DraftToolDeps,
  type ParsedRecipients,
  parseRecipients,
  type ResolvedIdentity,
  replyRecipients,
  replySubject,
  replyThreading,
  resolveIdentity,
} from './draft-common.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'
import { formatSent, submitDraft } from './send-draft.ts'

const MAX_RECIPIENTS = 50
const MAX_BODY_CHARS = 100_000

const overrideSchema = (field: string): z.ZodOptional<z.ZodArray<z.ZodString>> =>
  z
    .array(z.string().min(3).max(320))
    .max(MAX_RECIPIENTS)
    .optional()
    .describe(
      `Override the ${field} recipients instead of deriving them from the original message. Cannot be ` +
        'combined with `replyAll`.'
    )

export const replyToMessageInput = z.object({
  bcc: overrideSchema('Bcc'),
  cc: overrideSchema('Cc'),
  html: z.string().max(MAX_BODY_CHARS).optional().describe('HTML body of the reply.'),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Client-chosen key that makes this call safe to retry: a repeat with the same key returns the ' +
        'first call’s answer instead of sending a second reply. Pass one whenever the call might be retried.'
    ),
  messageId: z
    .string()
    .min(1)
    .describe('Id of the message being replied to, as returned by search_emails or get_thread.'),
  replyAll: z
    .boolean()
    .optional()
    .describe(
      'Reply to everyone: the original’s To and Cc are added to Cc, minus the user themselves. Cannot be ' +
        'combined with `to`, `cc`, or `bcc`.'
    ),
  subject: z.string().max(500).optional().describe('Override the subject. Defaults to "Re: <original subject>".'),
  text: z.string().max(MAX_BODY_CHARS).optional().describe('Plain-text body of the reply.'),
  to: overrideSchema('To'),
})

export type ReplyToMessageArgs = z.infer<typeof replyToMessageInput>

export interface ReplyToMessageContext {
  args: ReplyToMessageArgs
  principal: string
  token: string
}

const hasRecipientOverride = (args: ReplyToMessageArgs): boolean =>
  args.to !== undefined || args.cc !== undefined || args.bcc !== undefined

// Everything that can be rejected before a single JMAP call — and therefore
// before anything could possibly have been sent. Returns the refusal, or null
// when the arguments are coherent.
export const replyArgsError = (args: ReplyToMessageArgs): string | null => {
  if (args.text === undefined && args.html === undefined) {
    return 'Provide a body: `text`, `html`, or both.'
  }
  if (args.replyAll === true && hasRecipientOverride(args)) {
    return (
      'replyAll cannot be combined with to/cc/bcc. Either reply to everyone on the original, or name the ' +
      'recipients explicitly — not both. Nothing was sent.'
    )
  }
  return null
}

// Assemble the reply: recipients and threading derived from the original, with
// explicit `to`/`cc`/`bcc` overriding the derived ones. Split out of the tool
// body so the send path reads as resolve -> build -> stage -> submit.
const buildReply = (
  args: ReplyToMessageArgs,
  original: EmailComposeRecord,
  identity: ResolvedIdentity,
  recipients: ParsedRecipients
): { error: string } | { reply: EmailDraft } => {
  const derived = replyRecipients(original, identity.address.email, args.replyAll === true)
  const to = recipients.to ?? derived.to
  if (to.length === 0) {
    return {
      error: `Cannot reply: ${args.messageId} has no sender address to reply to. Pass \`to\` explicitly. Nothing was sent.`,
    }
  }
  const threading = replyThreading(original)
  return {
    reply: {
      from: [identity.address],
      to,
      cc: recipients.cc ?? derived.cc,
      ...(recipients.bcc ? { bcc: recipients.bcc } : {}),
      inReplyTo: threading.inReplyTo,
      references: threading.references,
      subject: args.subject ?? replySubject(original.subject),
      ...(args.text === undefined ? {} : { text: args.text }),
      ...(args.html === undefined ? {} : { html: args.html }),
    },
  }
}

export const replyToMessage = async (
  deps: DraftToolDeps,
  replays: IdempotencyStore<string>,
  ctx: ReplyToMessageContext
): Promise<ToolResult> => {
  const { args, principal, token } = ctx
  const argsError = replyArgsError(args)
  if (argsError) {
    return errorResult(argsError)
  }
  if (args.idempotencyKey) {
    const replayed = replays.lookup(principal, args.idempotencyKey)
    if (replayed) {
      return textResult(
        `${replayed}\n\n(Replayed: idempotencyKey "${args.idempotencyKey}" was already used — no second reply was sent.)`
      )
    }
  }

  const recipients = parseRecipients({
    ...(args.to ? { to: args.to } : {}),
    ...(args.cc ? { cc: args.cc } : {}),
    ...(args.bcc ? { bcc: args.bcc } : {}),
  })
  if ('error' in recipients) {
    return errorResult(recipients.error)
  }

  const authorization = bearerAuthorization(token)
  const accountId = await deps.resolveAccountId(authorization)
  const identity = await resolveIdentity(deps, {
    accountId: await deps.resolveSubmissionAccountId(authorization),
    authorization,
    principal,
  })
  if ('error' in identity) {
    return errorResult(identity.error)
  }

  const original = await deps.emailComposeGet({
    accountId,
    apiUrl: '',
    authorization,
    id: args.messageId,
    // Only the headers matter here — the original body is not quoted into the
    // reply.
    maxBodyValueBytes: 1,
  })
  if (!original) {
    return errorResult(`Cannot reply: message not found: ${args.messageId}. Nothing was sent.`)
  }

  const mailboxes = await deps.resolveComposeMailboxes(authorization)
  if (!mailboxes.drafts) {
    return errorResult('This account has no Drafts folder, so the reply cannot be composed.')
  }

  const built = buildReply(args, original, identity, recipients)
  if ('error' in built) {
    return errorResult(built.error)
  }
  const { reply } = built

  const staged = await deps.draftCreate({
    accountId,
    apiUrl: '',
    authorization,
    draft: reply,
    mailboxId: mailboxes.drafts,
  })
  const outcome = await submitDraft(deps, {
    authorization,
    draftId: staged.id,
    draftsMailboxId: mailboxes.drafts,
    identityId: identity.identityId,
    ...(mailboxes.sent ? { sentMailboxId: mailboxes.sent } : {}),
  })

  const summary = formatSent('Reply sent.', {
    draft: reply,
    messageId: staged.id,
    outcome,
    threadId: staged.threadId ?? original.threadId ?? null,
  })
  if (args.idempotencyKey) {
    replays.record(principal, args.idempotencyKey, summary)
  }
  return textResult(summary)
}

// --- MCP registration ----------------------------------------------------

export const registerReplyToMessage = (
  server: McpServer,
  deps: DraftToolDeps,
  replays: IdempotencyStore<string>,
  getToken: () => string,
  getPrincipal: () => string
): void => {
  server.registerTool(
    'reply_to_message',
    {
      annotations: OUTWARD_DESTRUCTIVE,
      description:
        'Reply to a message and send the reply immediately. This delivers mail to the recipients and ' +
        'cannot be undone — confirm with the user first unless they have already asked for the reply to ' +
        'be sent. To stage a reply for the user to review instead, use create_draft with `inReplyTo`. ' +
        'The recipients, the "Re:" subject, and the threading headers come from the original message; ' +
        '`replyAll` adds everyone it was addressed to, and cannot be combined with explicit to/cc/bcc. ' +
        'The original is not quoted — include any context the recipient needs in `text`. Returns the sent ' +
        'message’s id for get_email.',
      inputSchema: replyToMessageInput.shape,
      title: 'Reply to message',
    },
    (args) => {
      const parsed = replyToMessageInput.parse(args)
      return replyToMessage(deps, replays, { args: parsed, principal: getPrincipal(), token: getToken() })
    }
  )
}
