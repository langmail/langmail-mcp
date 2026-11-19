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
  type DraftDestroyResult,
  type EmailComposeRecord,
  type EmailSetParams,
  type EmailSubmissionCreateParams,
  type EmailSubmissionResult,
  type IdentityRecord,
} from '../jmap/index.ts'
import { type ComposeMailboxes, type DraftToolDeps } from './draft-common.ts'

export const TEST_PRINCIPAL = 'user@langmail.me'

const TEST_IDENTITIES: IdentityRecord[] = [{ email: TEST_PRINCIPAL, id: 'i1', name: 'Dana Okonjo' }]

// What separates the words the server indexes a subject or name into.
const NON_WORD_RE = /[^\p{L}\p{N}]+/u

const TEST_MAILBOXES: ComposeMailboxes = { drafts: 'mbDrafts', sent: 'mbSent', trash: 'mbTrash' }

export interface DraftDepsOptions {
  // Recorded blob uploads, newest last — what a test asserts on to tell
  // "re-referenced an existing blob" from "re-uploaded the bytes".
  blobUploads?: BlobUploadParams[]
  // What draftCreate reports back. Defaults to a fresh id.
  created?: DraftCreateResult
  // Recorded Email/set creates, newest last.
  creates?: DraftCreateParams[]
  // What draftDestroy reports back. Defaults to destroying the record.
  destroyResult?: DraftDestroyResult
  // Recorded Email/set destroys, by id — empty means nothing was deleted.
  destroys?: string[]
  identities?: IdentityRecord[]
  keywordSetError?: Error
  // Recorded keyword patches (`$forwarded` on a forwarded original), newest last.
  keywordSets?: EmailSetParams[]
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
    draftDestroy: (p) => {
      opts.destroys?.push(p.id)
      if (opts.destroyResult) {
        return Promise.resolve(opts.destroyResult)
      }
      if (!opts.records?.[p.id]) {
        return Promise.resolve({ notDestroyed: 'notFound' })
      }
      delete opts.records[p.id]
      return Promise.resolve({ destroyed: true })
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
    // Like the server: `$draft` mail in the given mailbox and not the excluded
    // one, newest first, with the text matched as a whole word (or address)
    // against the subject and every recipient.
    draftList: (p) => {
      const matches = Object.values(opts.records ?? {})
        .filter((record) => record.keywords?.$draft && record.mailboxIds?.[p.mailboxId])
        .filter((record) => !(p.excludeMailboxId && record.mailboxIds?.[p.excludeMailboxId]))
        .filter((record) => (p.after ? (record.receivedAt ?? '') >= p.after : true))
        .filter((record) => (p.before ? (record.receivedAt ?? '') < p.before : true))
        .filter((record) => {
          if (!p.text) {
            return true
          }
          const needle = p.text.toLowerCase()
          const haystack = [
            record.subject ?? '',
            ...[...(record.to ?? []), ...(record.cc ?? []), ...(record.bcc ?? [])].flatMap((a) => [
              a.email,
              a.name ?? '',
            ]),
          ]
          return haystack.some((value) => {
            const lower = value.toLowerCase()
            // The server also matches an address's domain as one term.
            const domain = lower.includes('@') ? [lower.slice(lower.indexOf('@') + 1)] : []
            return [lower, ...domain, ...lower.split(NON_WORD_RE)].includes(needle)
          })
        })
        .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''))
      return Promise.resolve({ records: matches.slice(0, p.limit), total: matches.length })
    },
    emailComposeGet: (p) => Promise.resolve(opts.records?.[p.id] ?? null),
    emailKeywordsSet: (p) => {
      opts.keywordSets?.push(p)
      return opts.keywordSetError ? Promise.reject(opts.keywordSetError) : Promise.resolve()
    },
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

// A draft as Apple Mail stages it: multipart/alternative with an empty
// text/plain part and the whole message in text/html.
export const APPLE_MAIL_HTML = '<div>Hi Sam,</div><div>the contract is attached, see you Monday.</div>'
export const appleMailDraft = (overrides: Partial<EmailComposeRecord> = {}): EmailComposeRecord =>
  stagedDraft({
    bodyValues: { '1': { value: '' }, '2': { value: APPLE_MAIL_HTML } },
    htmlBody: [{ partId: '2', type: 'text/html' }],
    to: [{ email: 'sam@example.com' }],
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
