// Typed JMAP wrappers for the EmailSubmission capability (RFC 8621 §6–7) —
// the account's sending identities and the submission that actually hands a
// staged draft to the SMTP queue.
//
// Sending is two facts on the wire and nothing else: which Email, and which
// Identity it goes out as. The envelope is deliberately not supplied — RFC 8621
// §7.5 has the server derive it from the message's own To/Cc/Bcc headers, which
// is both less to get wrong and the only way `bcc` reaches the queue while
// staying out of the delivered headers.

import { sentEmailPatch } from './drafts.ts'
import { jmapCall as call, type JmapCall, methodResponse } from './request.ts'
import { JmapError } from './session.ts'
import { type EmailSubmissionRecord, type IdentityRecord } from './types.ts'

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
  // The account's Sent mailbox. Absent (a server with no sent-role mailbox)
  // leaves the message where it is rather than failing the send.
  sentMailboxId?: string
}

// Submit a staged draft for delivery. The mailbox move (Drafts → Sent, `$draft`
// cleared) rides in `onSuccessUpdateEmail`, so Stalwart applies it in the same
// round-trip and only if the submission was accepted: a send can't half-commit
// into "delivered but still sitting in Drafts".
//
// The Email id is unchanged by the move, so the caller's `emailId` is also the
// id of the resulting sent message.
export const emailSubmissionCreate = async (p: EmailSubmissionCreateParams): Promise<EmailSubmissionRecord> => {
  const resp = await call(p, {
    methodCalls: [
      [
        'EmailSubmission/set',
        {
          accountId: p.accountId,
          create: { [CREATE_ID]: { emailId: p.emailId, identityId: p.identityId } },
          ...(p.sentMailboxId
            ? { onSuccessUpdateEmail: { [`#${CREATE_ID}`]: sentEmailPatch(p.draftsMailboxId, p.sentMailboxId) } }
            : {}),
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
  if (!created) {
    const reason = out.notCreated?.[CREATE_ID]
    // `type` is a JMAP error code (`forbiddenFrom`, `tooManyRecipients`, …),
    // not free text, so it's safe to surface; the description can quote the
    // message and stays out.
    throw new JmapError(200, `EmailSubmission/set did not send ${p.emailId}: ${reason?.type ?? 'unknown'}`)
  }
  return created
}
