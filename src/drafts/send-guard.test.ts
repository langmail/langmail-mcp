import { describe, expect, test } from 'bun:test'

import { createSendGuard, SEND_RESERVATION_TTL_MINUTES } from './send-guard.ts'

const USER = 'user@langmail.me'
const SEND_D1 = { key: 'd1', tool: 'send_draft' }
const SEND_D2 = { key: 'd2', tool: 'send_draft' }
const REPLY_D1 = { key: 'd1', tool: 'reply_to_message' }

describe('createSendGuard', () => {
  test('lets the first send through and holds the second', () => {
    const guard = createSendGuard()
    expect(guard.reserve(USER, SEND_D1)).toBeNull()
    expect(guard.reserve(USER, SEND_D1)).toEqual({ state: 'in_flight' })
  })

  test('scopes reservations by subject, tool, and principal', () => {
    const guard = createSendGuard()
    guard.reserve(USER, SEND_D1)
    expect(guard.reserve(USER, SEND_D2)).toBeNull()
    expect(guard.reserve('other@langmail.me', SEND_D1)).toBeNull()
    // Both ids come from the same Email id space, so sending draft X must not
    // block replying to message X.
    expect(guard.reserve(USER, REPLY_D1)).toBeNull()
  })

  test('release makes the draft sendable again', () => {
    const guard = createSendGuard()
    guard.reserve(USER, SEND_D1)
    guard.release(USER, SEND_D1)
    expect(guard.reserve(USER, SEND_D1)).toBeNull()
  })

  test('an unknown outcome keeps blocking, and says so', () => {
    const guard = createSendGuard()
    guard.reserve(USER, SEND_D1)
    guard.markUnknown(USER, SEND_D1)
    // A transport failure may have been accepted with the answer lost. Blocking
    // costs a manual re-send; releasing could cost a duplicate.
    expect(guard.reserve(USER, SEND_D1)).toEqual({ state: 'unknown' })
  })

  test('a reservation expires so a stuck send cannot block the draft forever', () => {
    let now = 1_000_000
    const guard = createSendGuard(() => now)
    guard.reserve(USER, SEND_D1)
    now += (SEND_RESERVATION_TTL_MINUTES + 1) * 60 * 1000
    expect(guard.reserve(USER, SEND_D1)).toBeNull()
  })
})
