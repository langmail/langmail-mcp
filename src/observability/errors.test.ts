import { describe, expect, test } from 'bun:test'

import { describeError } from './errors.ts'

class UpstreamError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'UpstreamError'
  }
}

describe('describeError', () => {
  test('reports the error class and an upstream status', () => {
    expect(describeError(new UpstreamError(502, 'caldav PUT returned 502'))).toEqual({
      errorClass: 'UpstreamError',
      errorMessage: 'caldav PUT returned 502',
      status: 502,
    })
  })

  test('omits status when the error carries none', () => {
    const detail = describeError(new Error('boom'))
    expect(detail).toEqual({ errorClass: 'Error', errorMessage: 'boom' })
    expect('status' in detail).toBe(false)
  })

  test('redacts mailbox addresses — these lines ship off-box', () => {
    expect(describeError(new Error('no mailbox for alice@langmail.me on this host')).errorMessage).toBe(
      'no mailbox for [email] on this host'
    )
  })

  test('redacts bearer tokens', () => {
    expect(describeError(new Error('rejected Bearer eyJhbGciOi.J9.abc')).errorMessage).toBe(
      'rejected Bearer [redacted]'
    )
  })

  test('truncates a long upstream body', () => {
    const detail = describeError(new Error('x'.repeat(500)))
    expect(detail.errorMessage.length).toBe(201)
    expect(detail.errorMessage.endsWith('…')).toBe(true)
  })

  test('handles a non-Error throw', () => {
    expect(describeError('plain string')).toEqual({ errorClass: 'string', errorMessage: 'plain string' })
  })
})
