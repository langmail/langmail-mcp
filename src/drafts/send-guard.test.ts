import { describe, expect, test } from 'bun:test'

import { createSendGuard, SEND_RESERVATION_TTL_MINUTES } from './send-guard.ts'

const USER = 'user@langmail.me'

describe('createSendGuard', () => {
  test('lets the first send through and holds the second', () => {
    const guard = createSendGuard()
    expect(guard.reserve(USER, 'd1')).toBeNull()
    expect(guard.reserve(USER, 'd1')).toEqual({ state: 'in_flight' })
  })

  test('scopes reservations by draft and by principal', () => {
    const guard = createSendGuard()
    guard.reserve(USER, 'd1')
    expect(guard.reserve(USER, 'd2')).toBeNull()
    expect(guard.reserve('other@langmail.me', 'd1')).toBeNull()
  })

  test('release makes the draft sendable again', () => {
    const guard = createSendGuard()
    guard.reserve(USER, 'd1')
    guard.release(USER, 'd1')
    expect(guard.reserve(USER, 'd1')).toBeNull()
  })

  test('an unknown outcome keeps blocking, and says so', () => {
    const guard = createSendGuard()
    guard.reserve(USER, 'd1')
    guard.markUnknown(USER, 'd1')
    // A transport failure may have been accepted with the answer lost. Blocking
    // costs a manual re-send; releasing could cost a duplicate.
    expect(guard.reserve(USER, 'd1')).toEqual({ state: 'unknown' })
  })

  test('a reservation expires so a stuck send cannot block the draft forever', () => {
    let now = 1_000_000
    const guard = createSendGuard(() => now)
    guard.reserve(USER, 'd1')
    now += (SEND_RESERVATION_TTL_MINUTES + 1) * 60 * 1000
    expect(guard.reserve(USER, 'd1')).toBeNull()
  })
})
