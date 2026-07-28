import { describe, expect, test } from 'bun:test'

import { fetchWithHeadersDeadline } from './timeout.ts'

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('fetchWithHeadersDeadline', () => {
  test('rejects when the upstream never answers', async () => {
    const hang = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })

    const err = await withFetch(hang, () =>
      fetchWithHeadersDeadline('https://mail.example.com/blob', {}, 10).catch((e: unknown) => e)
    )

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('did not respond within 10ms')
  })

  test('stops the clock once headers arrive, so a slow body is never cut off', async () => {
    // The whole point of the headers-only deadline: a blob download hands the
    // upstream body onward as a stream, and a large attachment legitimately
    // takes longer to transfer than the deadline allows for a stall.
    let captured: AbortSignal | undefined
    const answerHeaders = (_url: string, init?: RequestInit): Promise<Response> => {
      captured = init?.signal ?? undefined
      return Promise.resolve(new Response('body'))
    }

    await withFetch(answerHeaders, () => fetchWithHeadersDeadline('https://mail.example.com/blob', {}, 10))
    await sleep(40)

    expect(captured?.aborted).toBe(false)
  })
})
