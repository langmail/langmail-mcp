import { describe, expect, test } from 'bun:test'

import { LABEL_KEYWORD_PREFIX, toLabelKeyword } from './keywords.ts'

describe('keywords', () => {
  test('LABEL_KEYWORD_PREFIX matches the JMAP client label convention', () => {
    expect(LABEL_KEYWORD_PREFIX).toBe('$label:')
  })

  test('toLabelKeyword prefixes the suffix verbatim (no slug pass)', () => {
    expect(toLabelKeyword('receipt')).toBe('$label:receipt')
    expect(toLabelKeyword('todo')).toBe('$label:todo')
  })
})
