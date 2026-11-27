import { describe, expect, mock, spyOn, test } from 'bun:test'

import { logger } from '../logger/index.ts'
import { fetchUserinfo, UserinfoError } from './userinfo.ts'

const AUTH = 'https://auth.example.com/api/auth'

const withFetch = <T>(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>
): Promise<T> => {
  const original = globalThis.fetch
  globalThis.fetch = impl as unknown as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

describe('fetchUserinfo', () => {
  test('resolves the mailbox address (email claim), user id (sub), access level + exp from /oauth2/userinfo', async () => {
    const f = mock((url: string, init?: RequestInit) => {
      expect(url).toBe(`${AUTH}/oauth2/userinfo`)
      expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer abc')
      return Promise.resolve(
        Response.json(
          {
            email: 'alice@langmail.me',
            exp: 1_900_000_000,
            langmail_access: 'no-send',
            // Better Auth's `sub` is the user id, not the mailbox: the principal stays the email.
            sub: 'user_123',
          },
          { status: 200 }
        )
      )
    })
    const got = await withFetch(f, () => fetchUserinfo(AUTH, 'abc'))
    expect(got).toEqual({ access: 'no-send', exp: 1_900_000_000, principal: 'alice@langmail.me', userId: 'user_123' })
    expect(f).toHaveBeenCalledTimes(1)
  })

  test('throws UserinfoError with status on non-200', async () => {
    const f = mock(() => Promise.resolve(new Response('nope', { status: 401 })))
    await withFetch(f, async () => {
      const err = await fetchUserinfo(AUTH, 'tok').catch((error) => error)
      expect(err).toBeInstanceOf(UserinfoError)
      expect((err as UserinfoError).status).toBe(401)
    })
  })

  test('rejects a token with no email claim (non-mailbox user)', async () => {
    // A signed-in Google user without a langmail.me mailbox: Better Auth
    // suppresses the email claim, so the token can't act on a mailbox.
    const f = mock(() => Promise.resolve(Response.json({ exp: 1_900_000_000, sub: 'user_123' }, { status: 200 })))
    await withFetch(f, async () => {
      const err = await fetchUserinfo(AUTH, 'tok').catch((error) => error)
      expect(err).toBeInstanceOf(UserinfoError)
    })
  })

  test('rejects a response with no sub claim', async () => {
    const f = mock(() =>
      Promise.resolve(Response.json({ email: 'alice@langmail.me', exp: 1_900_000_000 }, { status: 200 }))
    )
    await withFetch(f, async () => {
      const err = await fetchUserinfo(AUTH, 'tok').catch((error) => error)
      expect(err).toBeInstanceOf(UserinfoError)
    })
  })

  test('synthesises exp ~1h ahead when response has no exp', async () => {
    const f = mock(() =>
      Promise.resolve(
        Response.json({ email: 'alice@langmail.me', langmail_access: 'everything', sub: 'user_123' }, { status: 200 })
      )
    )
    const before = Math.floor(Date.now() / 1000)
    const got = await withFetch(f, () => fetchUserinfo(AUTH, 'tok'))
    expect(got.exp).toBeGreaterThanOrEqual(before + 60)
    expect(got.exp).toBeLessThanOrEqual(before + 7200)
  })

  describe('langmail_access claim', () => {
    const accessFor = async (claims: Record<string, unknown>) => {
      const f = mock(() =>
        Promise.resolve(Response.json({ email: 'alice@langmail.me', sub: 'user_123', ...claims }, { status: 200 }))
      )
      const error = spyOn(logger, 'error').mockImplementation(() => undefined)
      try {
        const got = await withFetch(f, () => fetchUserinfo(AUTH, 'tok'))
        return { access: got.access, errors: error.mock.calls.length }
      } finally {
        error.mockRestore()
      }
    }

    test.each(['read-only', 'no-send', 'everything'])('reads %s as that level', async (level) => {
      expect(await accessFor({ langmail_access: level })).toEqual({ access: level, errors: 0 })
    })

    test('a missing claim runs the agent at read-only and logs an error', async () => {
      expect(await accessFor({})).toEqual({ access: 'read-only', errors: 1 })
    })

    test.each(['admin', 'Everything', 42, null])(
      'an unknown value (%p) runs it at read-only and logs an error',
      async (value) => {
        expect(await accessFor({ langmail_access: value })).toEqual({ access: 'read-only', errors: 1 })
      }
    )
  })
})
