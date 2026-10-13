// Shared fake `DraftToolDeps` for the composition tool tests.
//
// The composition tools share one deps bundle, so their tests share one fake:
// an in-memory mailbox of draft records, a fixed identity list, and arrays the
// caller can hand in to record what was created and submitted. Recording the
// calls rather than asserting inside the fake is what lets a test say "nothing
// was sent" — the strongest assertion on this surface.

import {
  type BlobUploadParams,
  type DraftCreateParams,
  type DraftCreateResult,
  type EmailComposeRecord,
  type EmailSubmissionCreateParams,
  type EmailSubmissionResult,
  type IdentityRecord,
} from '@langmail/jmap'

import { type ComposeMailboxes, type DraftToolDeps } from './draft-common.ts'

export const TEST_PRINCIPAL = 'user@langmail.me'

const TEST_IDENTITIES: IdentityRecord[] = [{ email: TEST_PRINCIPAL, id: 'i1', name: 'Dana Okonjo' }]

const TEST_MAILBOXES: ComposeMailboxes = { drafts: 'mbDrafts', sent: 'mbSent', trash: 'mbTrash' }

export interface DraftDepsOptions {
  // Recorded blob uploads, newest last — what a test asserts on to tell
  // "re-referenced an existing blob" from "re-uploaded the bytes".
  blobUploads?: BlobUploadParams[]
  // What draftCreate reports back. Defaults to a fresh id.
  created?: DraftCreateResult
  // Recorded Email/set creates, newest last.
  creates?: DraftCreateParams[]
  identities?: IdentityRecord[]
  mailboxes?: ComposeMailboxes
  // The mailbox emailComposeGet reads from, keyed by id. A missing id reads as null.
  records?: Record<string, EmailComposeRecord>
  submission?: EmailSubmissionResult
  // Recorded EmailSubmission/set calls — empty means nothing was sent.
  submissions?: EmailSubmissionCreateParams[]
  submitError?: Error
}

export const draftDeps = (opts: DraftDepsOptions = {}): DraftToolDeps => {
  // A fresh id per create, like a real server. A fixture that returned the same
  // id every time would make two independent drafts look like one — which is
  // exactly how a duplicate-send bug hides from its own test.
  let nextDraft = 0
  let nextBlob = 0
  return {
    blobUpload: (p) => {
      opts.blobUploads?.push(p)
      nextBlob += 1
      return Promise.resolve(`blobUploaded${nextBlob}`)
    },
    draftCreate: (p) => {
      opts.creates?.push(p)
      nextDraft += 1
      return Promise.resolve(opts.created ?? { id: `dNew${nextDraft}`, threadId: 'tNew' })
    },
    // Like the server: the newest record carrying the `$draftid:` keyword — by
    // receivedAt, and among equals the one listed last.
    draftIdResolve: (p) =>
      Promise.resolve(
        Object.values(opts.records ?? {})
          .filter((record) => record.keywords?.[`$draftid:${p.draftId}`])
          .reduce<EmailComposeRecord | null>(
            (newest, record) => (newest && (newest.receivedAt ?? '') > (record.receivedAt ?? '') ? newest : record),
            null
          )?.id ?? null
      ),
    emailComposeGet: (p) => Promise.resolve(opts.records?.[p.id] ?? null),
    emailSubmissionCreate: (p) => {
      opts.submissions?.push(p)
      if (opts.submitError) {
        return Promise.reject(opts.submitError)
      }
      return Promise.resolve(opts.submission ?? { filed: true, id: 's1', undoStatus: 'final' })
    },
    identityGet: () => Promise.resolve(opts.identities ?? TEST_IDENTITIES),
    resolveAccountId: () => Promise.resolve('acct'),
    resolveComposeMailboxes: () => Promise.resolve(opts.mailboxes ?? TEST_MAILBOXES),
    resolveSubmissionAccountId: () => Promise.resolve('acct'),
    // Like the server: a message of the same thread with that Message-ID.
    threadMessageFind: (p) => {
      const threadId = opts.records?.[p.emailId]?.threadId
      return Promise.resolve(
        Object.values(opts.records ?? {}).find(
          (record) => record.threadId === threadId && record.messageId?.includes(p.messageId)
        )?.id ?? null
      )
    },
  }
}

// A received message, as the reply paths see it.
export const receivedMessage = (overrides: Partial<EmailComposeRecord> = {}): EmailComposeRecord => ({
  cc: [{ email: 'carl@example.org' }],
  from: [{ email: 'nadia@example.org', name: 'Nadia Bram' }],
  id: 'e1',
  messageId: ['orig@example.org'],
  subject: 'Quarterly numbers',
  threadId: 't1',
  to: [{ email: TEST_PRINCIPAL }, { email: 'tomas@example.com' }],
  ...overrides,
})

// A staged draft, as get_draft / update_draft / send_draft see it.
export const stagedDraft = (overrides: Partial<EmailComposeRecord> = {}): EmailComposeRecord => ({
  bodyValues: { '1': { value: 'Here they are.' } },
  from: [{ email: TEST_PRINCIPAL, name: 'Dana Okonjo' }],
  id: 'd1',
  // Staged by create_draft, so it carries the draftId token — `d1` here, the
  // same as its JMAP id until an edit replaces it.
  keywords: { $draft: true, $seen: true, '$draftid:d1': true },
  mailboxIds: { mbDrafts: true },
  subject: 'Quarterly numbers',
  textBody: [{ partId: '1', type: 'text/plain' }],
  threadId: 't1',
  to: [{ email: 'nadia@example.org' }],
  ...overrides,
})

// A door a test opens by hand. Awaiting `passed` inside a fake dep pins a call at
// that await, so a test can run a second call past it and choose exactly how the
// two interleave — which is how the duplicate sends `spec/SendProtocol.tla`
// found are reproduced. `Promise.all` alone never produces them: fakes that
// resolve at once let both calls reach the reservation together.
export const gate = (): { open: () => void; passed: Promise<void> } => {
  let open = (): void => undefined
  const passed = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, passed }
}

// Let every call already started run until it is blocked on a gate.
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
