import { afterEach, describe, expect, it, mock } from 'bun:test'

import { type AuthServiceConfig, fetchStalwartCredential, StalwartCredentialError } from './stalwart-credential.ts'

const config: AuthServiceConfig = {
  baseUrl: 'https://auth.example.test',
  internalToken: 'internal-secret',
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetch(response: Response): ReturnType<typeof mock> {
  const fn = mock(() => Promise.resolve(response))
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

/** Answers with each entry in turn, so a retry sees a different outcome. */
function mockFetchSequence(responses: (() => Promise<Response>)[]): ReturnType<typeof mock> {
  let call = 0
  const fn = mock(() => {
    const next = responses[Math.min(call, responses.length - 1)]
    call++
    return next?.() ?? Promise.reject(new Error('no response configured'))
  })
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

const badGateway = () => Promise.resolve(new Response('<html>502 Bad Gateway</html>', { status: 502 }))
const credentialOk = () => Promise.resolve(Response.json({ address: 'alice@langmail.me', authorization: 'Basic ok' }))

describe('fetchStalwartCredential', () => {
  it('returns the Basic authorization and address on success', async () => {
    mockFetch(Response.json({ address: 'alice@langmail.me', authorization: 'Basic abc123' }))

    const result = await fetchStalwartCredential('user-uuid', config)

    expect(result).toEqual({ address: 'alice@langmail.me', authorization: 'Basic abc123' })
  })

  it('posts to the internal endpoint with the bearer token and userId body', async () => {
    const fn = mockFetch(Response.json({ address: 'a@b', authorization: 'Basic x' }))

    await fetchStalwartCredential('user-uuid', config)

    const [url, init] = fn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://auth.example.test/internal/stalwart-credential')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer internal-secret')
    expect(JSON.parse(init.body as string)).toEqual({ userId: 'user-uuid' })
  })

  it('resolves null on the no_active_mailbox 404 — the user simply has no mailbox', async () => {
    mockFetch(Response.json({ error: 'no_active_mailbox' }, { status: 404 }))

    await expect(fetchStalwartCredential('user-uuid', config)).resolves.toBeNull()
  })

  it('throws on a bare 404 (misrouted endpoint) instead of treating it as no-mailbox', async () => {
    mockFetch(new Response('not found', { status: 404 }))

    await expect(fetchStalwartCredential('user-uuid', config)).rejects.toBeInstanceOf(StalwartCredentialError)
  })

  it('throws StalwartCredentialError with the status on other non-200 responses', async () => {
    mockFetch(Response.json({ error: 'credential_unavailable' }, { status: 500 }))

    const error = await fetchStalwartCredential('user-uuid', config).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StalwartCredentialError)
    expect((error as StalwartCredentialError).status).toBe(500)
  })

  it('folds the status and error body into the message so telemetry can triage it', async () => {
    mockFetch(Response.json({ error: 'credential_unavailable' }, { status: 500 }))

    const error = await fetchStalwartCredential('user-uuid', config).catch((e: unknown) => e)

    // The pino/Sentry serializer only ships err.message, so the status must live
    // there — not just on the (dropped) `status` field.
    expect((error as StalwartCredentialError).message).toContain('500')
    expect((error as StalwartCredentialError).message).toContain('credential_unavailable')
  })

  it('throws when the body has no authorization, with the status in the message', async () => {
    mockFetch(Response.json({ address: 'a@b' }))

    const error = await fetchStalwartCredential('user-uuid', config).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StalwartCredentialError)
    expect((error as StalwartCredentialError).status).toBe(200)
    expect((error as StalwartCredentialError).message).toContain('200')
  })

  it('wraps a malformed (non-JSON) 200 body in StalwartCredentialError, with the status in the message', async () => {
    mockFetch(new Response('not json', { status: 200 }))

    const error = await fetchStalwartCredential('user-uuid', config).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StalwartCredentialError)
    expect((error as StalwartCredentialError).status).toBe(200)
    expect((error as StalwartCredentialError).message).toContain('200')
  })

  describe('transient failures', () => {
    it('retries a 502 and succeeds once the auth service is back', async () => {
      // The production failure: nginx answers 502 while the auth container is
      // restarting, which used to lose the caller's whole poll tick.
      const fn = mockFetchSequence([badGateway, credentialOk])

      const result = await fetchStalwartCredential('user-uuid', config)

      expect(result).toEqual({ address: 'alice@langmail.me', authorization: 'Basic ok' })
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('retries a network error, which never reached the endpoint at all', async () => {
      const fn = mockFetchSequence([() => Promise.reject(new Error('connect ECONNREFUSED')), credentialOk])

      await expect(fetchStalwartCredential('user-uuid', config)).resolves.toEqual({
        address: 'alice@langmail.me',
        authorization: 'Basic ok',
      })
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('gives up after the retry budget and reports the failure as transient', async () => {
      const fn = mockFetchSequence([badGateway])

      const error = await fetchStalwartCredential('user-uuid', config).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(StalwartCredentialError)
      expect((error as StalwartCredentialError).transient).toBe(true)
      expect((error as StalwartCredentialError).status).toBe(502)
      // The default budget: one attempt plus two retries.
      expect(fn).toHaveBeenCalledTimes(3)
    })

    it('does not retry a 401 — a bad internal token is an answer, not a blip', async () => {
      const fn = mockFetchSequence([() => Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }))])

      const error = await fetchStalwartCredential('user-uuid', config).catch((e: unknown) => e)

      expect((error as StalwartCredentialError).transient).toBe(false)
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('does not retry a 500 — the endpoint answered, it just could not decrypt', async () => {
      const fn = mockFetchSequence([
        () => Promise.resolve(Response.json({ error: 'credential_unavailable' }, { status: 500 })),
      ])

      const error = await fetchStalwartCredential('user-uuid', config).catch((e: unknown) => e)

      expect((error as StalwartCredentialError).transient).toBe(false)
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('honours retries: 0 for callers that own their own scheduling', async () => {
      const fn = mockFetchSequence([badGateway])

      await expect(fetchStalwartCredential('user-uuid', config, { retries: 0 })).rejects.toBeInstanceOf(
        StalwartCredentialError
      )
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('does not retry when the caller supplied a signal — the caller owns that deadline', async () => {
      const fn = mockFetchSequence([badGateway])

      await expect(
        fetchStalwartCredential('user-uuid', config, { signal: AbortSignal.timeout(5000) })
      ).rejects.toBeInstanceOf(StalwartCredentialError)
      expect(fn).toHaveBeenCalledTimes(1)
    })
  })
})
