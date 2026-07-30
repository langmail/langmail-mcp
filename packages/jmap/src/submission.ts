// Typed JMAP wrappers for the EmailSubmission capability (RFC 8621 §6–7) —
// the account's sending identities and the submission that actually hands a
// staged draft to the SMTP queue.
//
// Sending is two facts on the wire and nothing else: which Email, and which
// Identity it goes out as. The envelope is deliberately not supplied: RFC 8621
// §7.5 has the server derive it from the message's own To/Cc/Bcc headers, which
// is both less to get wrong and how `bcc` recipients reach the queue without the
// client assembling an envelope.
//
// Keeping `Bcc:` out of the *delivered* message is then the server's job, and the
// RFC does not require it — so it is asserted rather than assumed: Stalwart
// strips the header before handing the message to SMTP (`submission/set.rs`), and
// `drafts-stalwart.test.ts` checks the delivered copy has no bcc.

import { sentEmailPatch } from './drafts.ts'
import { jmapCall as call, type JmapCall, methodResponse } from './request.ts'
import { JmapError } from './session.ts'
import { type EmailSubmissionRecord, type IdentityRecord, type JmapResponse } from './types.ts'

// The mail capability rides along because `onSuccessUpdateEmail` is an implicit
// Email/set — Stalwart rejects the request if `using` omits it.
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission']

const CREATE_ID = 'send'

const IDENTITY_PROPERTIES = ['id', 'email', 'name', 'replyTo'] as const

export interface IdentityGetParams extends JmapCall {
  accountId: string
}

// Every address this account may send as. Stalwart returns one identity per
// configured address/alias; the caller picks by email and passes the `id` to
// `emailSubmissionCreate`.
export const identityGet = async (p: IdentityGetParams): Promise<IdentityRecord[]> => {
  const resp = await call(p, {
    methodCalls: [['Identity/get', { accountId: p.accountId, ids: null, properties: [...IDENTITY_PROPERTIES] }, '0']],
    using: USING,
  })
  const out = methodResponse<{ list?: IdentityRecord[] }>(resp, 'Identity/get', '0')
  return out.list ?? []
}

export interface EmailSubmissionCreateParams extends JmapCall {
  accountId: string
  // The account's Drafts mailbox — the sent message is moved out of it.
  draftsMailboxId: string
  emailId: string
  identityId: string
  // The account's Sent mailbox. Absent (an account with no sent-role mailbox)
  // leaves the message in Drafts rather than failing the send — but it is still
  // marked as no longer a draft, so a second send call can tell.
  sentMailboxId?: string
}

// What a send reports back: the submission itself, plus whether the follow-up
// bookkeeping actually landed.
export interface EmailSubmissionResult extends EmailSubmissionRecord {
  // Whether `onSuccessUpdateEmail` applied — i.e. whether the message is now
  // marked as no longer a draft. `false` means the mail went out but the mailbox
  // still says otherwise, which is exactly the state a caller must not treat as
  // retryable: see the comment on the read below.
  filed: boolean
}

// Submit a staged draft for delivery, and clear `$draft` / move it to Sent in the
// same request via `onSuccessUpdateEmail`.
//
// RFC 8621 §7.5 makes that patch a *separate implicit Email/set*, performed after
// the submissions and answered under the same call id — and, crucially, its
// failure does not fail the submission. So its response has to be read: if it
// were ignored, a rejected patch (a Sent mailbox destroyed by another client
// between the mailbox lookup and this call, say) would leave the message
// delivered but still flagged `$draft`, and a caller retrying on that flag would
// send it a second time. That flag is the whole structural duplicate-send guard,
// so silently trusting it to have changed is not an option.
//
// The Email id is unchanged by the move, so the caller's `emailId` is also the
// id of the resulting sent message.
export const emailSubmissionCreate = async (p: EmailSubmissionCreateParams): Promise<EmailSubmissionResult> => {
  const resp = await call(p, {
    methodCalls: [
      [
        'EmailSubmission/set',
        {
          accountId: p.accountId,
          create: { [CREATE_ID]: { emailId: p.emailId, identityId: p.identityId } },
          onSuccessUpdateEmail: {
            [`#${CREATE_ID}`]: sentEmailPatch(p.draftsMailboxId, p.sentMailboxId),
          },
        },
        '0',
      ],
    ],
    using: USING,
  })
  const out = methodResponse<{
    created?: Record<string, EmailSubmissionRecord>
    notCreated?: Record<string, { description?: string; type?: string }>
  }>(resp, 'EmailSubmission/set', '0')
  const created = out.created?.[CREATE_ID]
  if (!created?.id) {
    const reason = out.notCreated?.[CREATE_ID]
    // `type` is a JMAP error code (`forbiddenFrom`, `tooManyRecipients`, …),
    // not free text, so it's safe to surface; the description can quote the
    // message and stays out.
    // `type` is passed through as the error type, not just interpolated: callers
    // branch on it to tell "the server refused, nothing was sent" from "the
    // answer never arrived, delivery unknown" — and those two demand opposite
    // retry behaviour.
    throw new JmapError(
      200,
      `EmailSubmission/set did not send ${p.emailId}: ${reason?.type ?? 'unknown'}`,
      reason?.type
    )
  }
  return { ...created, filed: emailWasPatched(resp, p.emailId) }
}

// Read the implicit Email/set that `onSuccessUpdateEmail` triggers. A server that
// performed no such call at all counts as not filed — the point of the check is
// to know the flag changed, and "no evidence" is not "yes".
const emailWasPatched = (resp: JmapResponse, emailId: string): boolean => {
  const entry = resp.methodResponses.find(([name, , id]) => name === 'Email/set' && id === '0')
  if (!entry) {
    return false
  }
  const body = entry[1] as { notUpdated?: Record<string, unknown>; updated?: Record<string, unknown> }
  return Boolean(body.updated && emailId in body.updated) && !(emailId in (body.notUpdated ?? {}))
}
