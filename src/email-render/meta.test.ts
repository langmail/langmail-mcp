import { describe, expect, test } from 'bun:test'

import { emailDocument } from './meta.ts'

describe('emailDocument', () => {
  test('wraps the sanitized body in a light-scheme document', () => {
    const doc = emailDocument('<p>Seats G6, G5</p>')
    // Without an explicit scheme the nested srcdoc inherits the host's dark
    // color-scheme — black canvas, white UA text. Email is authored for white.
    expect(doc).toContain('<meta name="color-scheme" content="light">')
    expect(doc).toContain('body{margin:12px;background:#fff;color:#000}')
    expect(doc).toContain('<body><p>Seats G6, G5</p></body>')
  })
})
