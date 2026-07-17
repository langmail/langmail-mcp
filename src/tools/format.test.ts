import { describe, expect, test } from 'bun:test'

import { formatEmailLine, formatSize } from './format.ts'

describe('formatEmailLine', () => {
  test('appends an attachments marker when hasAttachment is true', () => {
    const line = formatEmailLine(1, {
      from: [{ email: 'a@x' }],
      hasAttachment: true,
      id: 'e1',
      receivedAt: '2026-06-01T00:00:00Z',
      subject: 'Invoice',
    })
    expect(line).toContain('attachments: yes')
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
