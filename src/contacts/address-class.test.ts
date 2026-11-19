import { describe, expect, test } from 'bun:test'

import { classifyContext, isRelayAddress, normalizeAddress } from './address-class.ts'

describe('isRelayAddress', () => {
  test('flags the no-reply family and digest senders', () => {
    expect(isRelayAddress('noreply@somecorp.com')).toBe(true)
    expect(isRelayAddress('no-reply@somecorp.com')).toBe(true)
    expect(isRelayAddress('do-not-reply@somecorp.com')).toBe(true)
    expect(isRelayAddress('mailer-daemon@somecorp.com')).toBe(true)
    expect(isRelayAddress('messaging-digest-noreply@linkedin.com')).toBe(true)
    expect(isRelayAddress('notifications@github.com')).toBe(true)
    expect(isRelayAddress('bounces+12345@sendgrid.example.org')).toBe(true)
  })

  test('flags known relay domains including subdomains', () => {
    expect(isRelayAddress('jobs@linkedin.com')).toBe(true)
    expect(isRelayAddress('anything@bounce.linkedin.com')).toBe(true)
    expect(isRelayAddress('updates@facebookmail.com')).toBe(true)
  })

  test('does not swallow humans whose names embed a keyword', () => {
    expect(isRelayAddress('annareply@example.com')).toBe(false)
    expect(isRelayAddress('robin@northwind.example')).toBe(false)
    expect(isRelayAddress('digestive.health@clinic.example')).toBe(false)
  })
})

describe('classifyContext', () => {
  test('freemail and langmail domains are private, organization domains are work', () => {
    expect(classifyContext('robin.private@gmail.com')).toBe('private')
    expect(classifyContext('robin@langmail.me')).toBe('private')
    expect(classifyContext('robin@northwind.example')).toBe('work')
  })
})

describe('normalizeAddress', () => {
  test('lowercases and trims', () => {
    expect(normalizeAddress('  Robin@NorthWind.example ')).toBe('robin@northwind.example')
  })
})
