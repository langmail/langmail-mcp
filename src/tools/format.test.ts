import { describe, expect, test } from 'bun:test'

import { type EmailRecord, type MailboxRecord } from '../jmap/index.ts'
import { emailFlags, emailFolders, emailTags, formatEmailLine, formatSize } from './format.ts'

// A hit rendered without a mailbox listing, for tests about the other lines.
const lineOf = (e: EmailRecord): string => formatEmailLine(1, e, [])

// Stalwart's stock names differ from the place names ("Sent Items", "Junk Mail").
const MAILBOXES: MailboxRecord[] = [
  { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
  { id: 'mb-archive', name: 'Archive', role: 'archive' },
  { id: 'mb-sent', name: 'Sent Items', role: 'sent' },
  { id: 'mb-junk', name: 'Junk Mail', role: 'junk' },
  { id: 'mb-trash', name: 'Deleted Items', role: 'trash' },
  { id: 'mb-projects', name: 'Projects', role: null },
  { id: 'mb-clients', name: 'clients', role: null },
]

describe('emailFolders', () => {
  test('shows a role mailbox under its place name and a user folder under its own', () => {
    expect(emailFolders({ mailboxIds: { 'mb-junk': true } }, MAILBOXES)).toEqual(['Junk'])
    expect(emailFolders({ mailboxIds: { 'mb-trash': true } }, MAILBOXES)).toEqual(['Trash'])
    expect(emailFolders({ mailboxIds: { 'mb-projects': true } }, MAILBOXES)).toEqual(['Projects'])
  })

  test('lists every folder, places first in a fixed order, then user folders by name', () => {
    expect(
      emailFolders(
        { mailboxIds: { 'mb-projects': true, 'mb-sent': true, 'mb-archive': true, 'mb-clients': true } },
        MAILBOXES
      )
    ).toEqual(['Archive', 'Sent', 'clients', 'Projects'])
  })

  test('leaves out ids missing from the listing and false entries', () => {
    expect(emailFolders({ mailboxIds: { 'mb-gone': true, 'mb-inbox': false } }, MAILBOXES)).toEqual([])
    expect(emailFolders({}, MAILBOXES)).toEqual([])
  })
})

describe('emailTags', () => {
  test('renders $label: and $type: keywords, ignoring system flags', () => {
    expect(
      emailTags({
        id: 'e1',
        keywords: { '$label:newsletter': true, '$label:todo': true, $seen: true, '$type:ticket': true },
      })
    ).toEqual(['newsletter', 'todo', 'ticket'])
  })

  // The namespaces overlap by design: receipt-agent writes `$label:receipt`
  // for the same mail the classifier types `receipt`.
  test('shows a suffix carried by both namespaces exactly once', () => {
    expect(emailTags({ id: 'e1', keywords: { '$label:receipt': true, '$type:receipt': true } })).toEqual(['receipt'])
  })

  test('returns nothing for a message with no keywords', () => {
    expect(emailTags({ id: 'e1' })).toEqual([])
  })
})

describe('emailFlags', () => {
  test('names unread and starred, and nothing for a read, unstarred message', () => {
    expect(emailFlags({ id: 'e1', keywords: { $flagged: true } })).toEqual(['unread', 'starred'])
    expect(emailFlags({ id: 'e1' })).toEqual(['unread'])
    expect(emailFlags({ id: 'e1', keywords: { $seen: true } })).toEqual([])
  })
})

describe('formatEmailLine', () => {
  test('names the folders after the date line', () => {
    const line = formatEmailLine(
      1,
      { id: 'e1', mailboxIds: { 'mb-archive': true, 'mb-sent': true }, receivedAt: '2026-06-01T00:00:00Z' },
      MAILBOXES
    )
    expect(line).toContain('   date: 2026-06-01T00:00:00Z\n   folders: Archive, Sent')
  })

  test('omits the folders line when no folder is known', () => {
    expect(formatEmailLine(1, { id: 'e1', mailboxIds: { 'mb-x': true } }, MAILBOXES)).not.toContain('folders:')
  })

  test('shows the flags line only when a flag is set', () => {
    expect(lineOf({ id: 'e1', keywords: { $flagged: true, $seen: true } })).toContain('   flags: starred')
    expect(lineOf({ id: 'e1', keywords: { $seen: true } })).not.toContain('flags:')
  })

  test('renders a whitespace-normalized snippet when preview is present', () => {
    const line = lineOf({
      id: 'e1',
      preview: ' Invoice No.\n  IWGKCS-00018\t $34.86 ',
      subject: 'Invoice',
    })
    expect(line).toContain('snippet: Invoice No. IWGKCS-00018 $34.86')
  })

  test('omits the snippet when preview is empty after trimming whitespace', () => {
    const line = lineOf({
      id: 'e1',
      preview: ' \n\t ',
      subject: 'Invoice',
    })
    expect(line).not.toContain('snippet:')
  })

  test('renders non-inline attachment metadata with blobId when hasAttachment is true', () => {
    const line = lineOf({
      attachments: [
        {
          blobId: 'Gpdf',
          disposition: 'attachment',
          name: 'invoice.pdf',
          size: 35_738,
          type: 'application/pdf',
        },
        {
          blobId: 'Glogo',
          cid: 'logo@example',
          disposition: 'inline',
          name: 'logo.png',
          size: 512,
          type: 'image/png',
        },
      ],
      from: [{ email: 'a@x' }],
      hasAttachment: true,
      id: 'e1',
      receivedAt: '2026-06-01T00:00:00Z',
      subject: 'Invoice',
    })
    expect(line).toContain('attachments:')
    expect(line).toContain('invoice.pdf — application/pdf, 34.9 KB — blobId: Gpdf')
    expect(line).not.toContain('logo.png')
  })

  test('caps list-level attachment metadata at five parts with a remainder tail', () => {
    const line = lineOf({
      attachments: Array.from({ length: 7 }, (_, i) => ({
        blobId: `G${i + 1}`,
        disposition: 'attachment',
        name: `file-${i + 1}.pdf`,
        size: 1024,
        type: 'application/pdf',
      })),
      hasAttachment: true,
      id: 'e1',
      subject: 'Bundle',
    })
    expect(line).toContain('file-5.pdf — application/pdf, 1.0 KB — blobId: G5')
    expect(line).not.toContain('file-6.pdf')
    expect(line).toContain('… +2 more (see get_email)')
  })

  test('falls back to the old marker when hasAttachment is true but no non-inline parts are available', () => {
    const line = lineOf({
      attachments: [
        {
          blobId: 'Glogo',
          cid: 'logo@example',
          disposition: 'inline',
          name: 'logo.png',
          size: 512,
          type: 'image/png',
        },
      ],
      hasAttachment: true,
      id: 'e1',
      subject: 'Invoice',
    })
    expect(line).toContain('attachments: yes')
    expect(line).not.toContain('logo.png')
  })

  test('omits the marker when hasAttachment is false or absent', () => {
    expect(lineOf({ hasAttachment: false, id: 'e1', subject: 'Plain' })).not.toContain('attachments')
    expect(lineOf({ id: 'e2', subject: 'Plain' })).not.toContain('attachments')
  })
})

describe('formatSize', () => {
  test('formats bytes, KB, and MB human-readably', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(186_778)).toBe('182.4 KB')
    expect(formatSize(2 * 1024 * 1024)).toBe('2.0 MB')
  })
})
