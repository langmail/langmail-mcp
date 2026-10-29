import { describe, expect, test } from 'bun:test'

import { emailFlags, emailTags, formatEmailLine, formatSize } from './format.ts'

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
  test('shows the flags line only when a flag is set', () => {
    expect(formatEmailLine(1, { id: 'e1', keywords: { $flagged: true, $seen: true } })).toContain('   flags: starred')
    expect(formatEmailLine(1, { id: 'e1', keywords: { $seen: true } })).not.toContain('flags:')
  })

  test('renders a whitespace-normalized snippet when preview is present', () => {
    const line = formatEmailLine(1, {
      id: 'e1',
      preview: ' Invoice No.\n  IWGKCS-00018\t $34.86 ',
      subject: 'Invoice',
    })
    expect(line).toContain('snippet: Invoice No. IWGKCS-00018 $34.86')
  })

  test('omits the snippet when preview is empty after trimming whitespace', () => {
    const line = formatEmailLine(1, {
      id: 'e1',
      preview: ' \n\t ',
      subject: 'Invoice',
    })
    expect(line).not.toContain('snippet:')
  })

  test('renders non-inline attachment metadata with blobId when hasAttachment is true', () => {
    const line = formatEmailLine(1, {
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
    const line = formatEmailLine(1, {
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
    const line = formatEmailLine(1, {
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
    expect(formatEmailLine(1, { hasAttachment: false, id: 'e1', subject: 'Plain' })).not.toContain('attachments')
    expect(formatEmailLine(1, { id: 'e2', subject: 'Plain' })).not.toContain('attachments')
  })
})

describe('formatSize', () => {
  test('formats bytes, KB, and MB human-readably', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(186_778)).toBe('182.4 KB')
    expect(formatSize(2 * 1024 * 1024)).toBe('2.0 MB')
  })
})
