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
})
