import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { hashEmail } from './hash'

const TWELVE_HEX_CHARS = /^[0-9a-f]{12}$/

// hashEmail is the PII-redaction primitive every service reaches for before an
// address (or any other identifying token) reaches a log line, so its contract
// is load-bearing in two directions: the output must stay stable enough to
// correlate records across services, and it must not carry the plaintext.

describe('hashEmail', () => {
  test('is a 12-character lowercase hex digest', () => {
    const hash = hashEmail('wren@example.com')
    expect(hash).toHaveLength(12)
    expect(hash).toMatch(TWELVE_HEX_CHARS)
  })

  test('matches known SHA-256 vectors, truncated to 12 hex chars', () => {
    // Pinned literals, not a re-implementation: changing the algorithm or the
    // truncation length breaks correlation with every log line already shipped.
    expect(hashEmail('wren@example.com')).toBe('4be15ac83ae8')
    expect(hashEmail('tovald@example.org')).toBe('49a3135ca77a')
  })

  test('is the first 12 hex chars of SHA-256 over the lowercased input', () => {
    const address = 'quillan@example.net'
    const expected = createHash('sha256').update(address).digest('hex').slice(0, 12)
    expect(hashEmail(address)).toBe(expected)
  })

  test('is deterministic across calls', () => {
    expect(hashEmail('wren@example.com')).toBe(hashEmail('wren@example.com'))
  })

  test('folds case, so one mailbox maps to one hash however it was typed', () => {
    const expected = hashEmail('wren@example.com')
    expect(hashEmail('WREN@EXAMPLE.COM')).toBe(expected)
    expect(hashEmail('WREN@Example.COM')).toBe(expected)
    expect(hashEmail('Wren@Example.Com')).toBe(expected)
  })

  test('separates distinct addresses', () => {
    const hashes = new Set([
      hashEmail('wren@example.com'),
      hashEmail('tovald@example.com'),
      hashEmail('wren@example.org'),
      hashEmail('wren+news@example.com'),
    ])
    expect(hashes.size).toBe(4)
  })

  test('leaks no fragment of the plaintext', () => {
    const hash = hashEmail('wren.halloway@example.com')
    expect(hash).not.toContain('@')
    expect(hash).not.toContain('wren')
    expect(hash).not.toContain('halloway')
    expect(hash).not.toContain('example')
  })

  describe('inputs that are not addresses', () => {
    // Callers pass opaque identifiers through this same helper — a Google
    // `sub` in account-hooks, an iCalendar UID in the MCP calendar tool — so
    // it has to behave as a general identifier hash, not just an email one.
    test('hashes an opaque numeric subject identifier', () => {
      expect(hashEmail('109876543210987654321')).toBe('58d79e70f6b9')
    })

    test('hashes an empty string rather than throwing', () => {
      // The empty-string SHA-256; callers hand it fields that may be blank and
      // must not have a log call take down the surrounding operation.
      expect(hashEmail('')).toBe('e3b0c44298fc')
    })

    test('hashes a UID containing mixed case and punctuation', () => {
      const uid = 'A1B2-C3D4@example.invalid'
      expect(hashEmail(uid)).toBe(hashEmail(uid.toLowerCase()))
      expect(hashEmail(uid)).toMatch(TWELVE_HEX_CHARS)
    })
  })

  describe('normalisation it does NOT perform', () => {
    // Documenting current behavior, not endorsing it: only case is folded.
    test('does not trim surrounding whitespace', () => {
      expect(hashEmail(' wren@example.com')).not.toBe(hashEmail('wren@example.com'))
      expect(hashEmail('wren@example.com ')).not.toBe(hashEmail('wren@example.com'))
    })

    test('does not strip gmail-style dots or plus tags', () => {
      const plain = hashEmail('synthetictester@gmail.com')
      expect(hashEmail('synthetic.tester@gmail.com')).not.toBe(plain)
      expect(hashEmail('synthetictester+news@gmail.com')).not.toBe(plain)
    })
  })

  test('is unsalted, so an equal input is recognisable by anyone with the digest', () => {
    // Recorded deliberately. A 48-bit unsalted digest over a low-entropy input
    // is a pseudonym, not a secret: anyone holding a candidate address can
    // confirm it against a log line. That is the accepted trade for making
    // hashes correlatable across services — the point is that it is a known
    // property, so nothing downstream should treat these as unlinkable.
    const candidate = 'wren@example.com'
    const fromLogs = '4be15ac83ae8'
    expect(hashEmail(candidate)).toBe(fromLogs)
  })
})
