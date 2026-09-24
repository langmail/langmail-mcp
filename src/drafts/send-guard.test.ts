import { describe, expect, test } from 'bun:test'

import { createSendGuard, holdSend, SEND_RESERVATION_TTL_MINUTES } from './send-guard.ts'

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

describe('holdSend', () => {
  test('refuses when another call holds the first subject', () => {
    const guard = createSendGuard()
    guard.reserve(USER, REPLY_D1)
    expect(holdSend(guard, USER, REPLY_D1)).toEqual({ refused: { state: 'in_flight' } })
  })

  test('ending the hold releases every subject it covered', () => {
    const guard = createSendGuard()
    const taken = holdSend(guard, USER, REPLY_D1)
    if (!('hold' in taken)) {
      throw new Error('expected the hold to be taken')
    }
    expect(taken.hold.cover(SEND_D2)).toBeNull()
    // Covered subjects are held against everyone else until the hold ends.
    expect(guard.reserve(USER, SEND_D2)).toEqual({ state: 'in_flight' })
    taken.hold.end()
    expect(guard.reserve(USER, REPLY_D1)).toBeNull()
  })

  test('an unknown outcome keeps every covered subject blocked', () => {
    const guard = createSendGuard()
    const taken = holdSend(guard, USER, REPLY_D1)
    if (!('hold' in taken)) {
      throw new Error('expected the hold to be taken')
    }
    taken.hold.cover(SEND_D2)
    taken.hold.markUnknown()
    taken.hold.end()
    expect(guard.reserve(USER, REPLY_D1)).toEqual({ state: 'unknown' })
    expect(guard.reserve(USER, SEND_D2)).toEqual({ state: 'unknown' })
  })

  test('a call whose swept reservation ends unknown still blocks the next send', () => {
    let now = 0
    const guard = createSendGuard(() => now)
    const first = holdSend(guard, USER, SEND_D1)
    if (!('hold' in first)) {
      throw new Error('expected the hold to be taken')
    }
    // Past the TTL, a reserve on any subject sweeps the first call's entry.
    now += (SEND_RESERVATION_TTL_MINUTES + 1) * 60 * 1000
    guard.reserve(USER, SEND_D2)
    // The answer is then lost: delivery is unknown, and nobody else holds d1,
    // so the unknown must be recorded rather than dropped with the entry.
    first.hold.markUnknown()
    first.hold.end()
    expect(guard.reserve(USER, SEND_D1)).toEqual({ state: 'unknown' })
  })

  test('a call that outlived its reservation cannot end the retry that took it over', () => {
    let now = 0
    const guard = createSendGuard(() => now)
    const first = holdSend(guard, USER, SEND_D1)
    if (!('hold' in first)) {
      throw new Error('expected the hold to be taken')
    }
    // The first call runs past the TTL; its entry is swept and a retry takes it.
    now += (SEND_RESERVATION_TTL_MINUTES + 1) * 60 * 1000
    const second = holdSend(guard, USER, SEND_D1)
    if (!('hold' in second)) {
      throw new Error('expected the expired reservation to be taken over')
    }
    // Releasing by subject alone would drop the retry's live reservation and
    // let a third call submit alongside it.
    first.hold.end()
    expect(guard.reserve(USER, SEND_D1)).toEqual({ state: 'in_flight' })
    first.hold.markUnknown()
    first.hold.end()
    expect(guard.reserve(USER, SEND_D1)).toEqual({ state: 'in_flight' })
  })
})
