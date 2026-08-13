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

const TEST_MAILBOXES: ComposeMailboxes = { drafts: 'mbDrafts', sent: 'mbSent' }

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
  keywords: { $draft: true, $seen: true },
  mailboxIds: { mbDrafts: true },
  subject: 'Quarterly numbers',
  textBody: [{ partId: '1', type: 'text/plain' }],
  threadId: 't1',
  to: [{ email: 'nadia@example.org' }],
  ...overrides,
})
