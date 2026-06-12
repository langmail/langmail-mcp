import { describe, expect, test } from 'bun:test'

import { pickDefaultCalendar, pickOrganizer, withTrailingSlash } from './client.ts'
import type { CalendarSummary } from './types.ts'

const cal = (url: string, displayName = ''): CalendarSummary => ({ displayName, url })

describe('pickDefaultCalendar', () => {
  test('prefers a /default/ collection', () => {
    const cals = [cal('https://m/dav/cal/u/work/'), cal('https://m/dav/cal/u/default/')]
    expect(pickDefaultCalendar(cals)).toBe('https://m/dav/cal/u/default/')
  })

  test('falls back to the first calendar when none is /default/', () => {
    const cals = [cal('https://m/dav/cal/u/work/'), cal('https://m/dav/cal/u/home/')]
    expect(pickDefaultCalendar(cals)).toBe('https://m/dav/cal/u/work/')
  })

  test('matches a /default collection without a trailing slash', () => {
    const cals = [cal('https://m/dav/cal/u/work/'), cal('https://m/dav/cal/u/default')]
    expect(pickDefaultCalendar(cals)).toBe('https://m/dav/cal/u/default')
  })

  test('returns null for an empty list', () => {
    expect(pickDefaultCalendar([])).toBeNull()
  })
})

describe('withTrailingSlash', () => {
  test('appends a slash when missing', () => {
    expect(withTrailingSlash('https://m/dav/cal/u/team')).toBe('https://m/dav/cal/u/team/')
  })

  test('leaves an already-slashed url unchanged', () => {
    expect(withTrailingSlash('https://m/dav/cal/u/team/')).toBe('https://m/dav/cal/u/team/')
  })
})

describe('pickOrganizer', () => {
  test('strips the mailto: prefix from the first address', () => {
    expect(pickOrganizer(['mailto:host@langmail.me'])).toBe('host@langmail.me')
  })

  test('prefers the mailto: address when a principal URL is listed first', () => {
    expect(pickOrganizer(['/dav/pal/host%40langmail.me/', 'mailto:host@langmail.me'])).toBe('host@langmail.me')
  })

  test('returns null when no mailto: address is present', () => {
    expect(pickOrganizer(['/dav/pal/host%40langmail.me/'])).toBeNull()
  })

  test('returns null when there are no addresses', () => {
    expect(pickOrganizer([])).toBeNull()
  })
})
