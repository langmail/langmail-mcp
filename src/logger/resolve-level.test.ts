import { describe, expect, test } from 'bun:test'

import { resolveLevel } from './resolve-level'

// Pino level strings are case-sensitive: an unknown level like "INFO" doesn't
// throw — pino.multistream silently drops every record. resolveLevel must make
// that misconfiguration impossible.
describe('resolveLevel', () => {
  test('defaults to info when unset', () => {
    expect(resolveLevel(undefined)).toBe('info')
  })

  test('passes through valid lowercase levels', () => {
    expect(resolveLevel('debug')).toBe('debug')
    expect(resolveLevel('warn')).toBe('warn')
  })

  test('lowercases uppercase levels', () => {
    expect(resolveLevel('INFO')).toBe('info')
    expect(resolveLevel('Debug')).toBe('debug')
  })

  test('trims surrounding whitespace', () => {
    expect(resolveLevel('debug ')).toBe('debug')
  })

  test('treats empty and blank strings as unset', () => {
    expect(resolveLevel('')).toBe('info')
    expect(resolveLevel('  ')).toBe('info')
  })

  test('falls back to info on unknown levels, with a stderr warning', () => {
    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      expect(resolveLevel('verbose')).toBe('info')
      expect(resolveLevel('silent')).toBe('info')
    } finally {
      process.stderr.write = original
    }
    expect(written.join('')).toContain('unknown LOG_LEVEL "verbose"')
  })
})
