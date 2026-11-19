// The node:http listener the self-hosted server uses under Node and Bun.
// node:test, not bun:test: CI runs this file under Node as well
// (scripts/test-node.ts).

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { type FetchHandler, listen } from './listen.ts'

const failed = (error: unknown): Response => new Response(`failed: ${String(error)}`, { status: 500 })

const withListener = async (fetch: FetchHandler, body: (url: string) => Promise<void>): Promise<void> => {
  const server = await listen({ fetch, host: '127.0.0.1', onError: failed, port: 0 })
  try {
    await body(`http://127.0.0.1:${server.port}`)
  } finally {
    await server.stop()
  }
}

describe('listen', () => {
  test('passes method, path, query, headers and body through, and the answer back', async () => {
    await withListener(
      async (req) => {
        const url = new URL(req.url)
        return Response.json(
          {
            auth: req.headers.get('authorization'),
            body: await req.text(),
            method: req.method,
            path: url.pathname + url.search,
          },
          { headers: { 'set-cookie': 'a=1', 'x-answer': 'yes' }, status: 201 }
        )
      },
      async (url) => {
        const res = await fetch(`${url}/mcp?x=1`, {
          body: 'hello',
          headers: { authorization: 'Bearer t' },
          method: 'POST',
        })
        assert.equal(res.status, 201)
        assert.equal(res.headers.get('x-answer'), 'yes')
        assert.equal(res.headers.get('set-cookie'), 'a=1')
        assert.deepEqual(await res.json(), { auth: 'Bearer t', body: 'hello', method: 'POST', path: '/mcp?x=1' })
      }
    )
  })

  test('streams a response body chunk by chunk', async () => {
    let release: () => void = () => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    await withListener(
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start: async (controller) => {
                controller.enqueue(new TextEncoder().encode('data: first\n\n'))
                await released
                controller.enqueue(new TextEncoder().encode('data: second\n\n'))
                controller.close()
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          )
        ),
      async (url) => {
        const res = await fetch(url)
        const reader = res.body?.getReader()
        assert.ok(reader)
        // The first event arrives while the second is still held back.
        const first = await reader.read()
        assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n')
        release()
        let rest = ''
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          rest += new TextDecoder().decode(chunk.value)
        }
        assert.equal(rest, 'data: second\n\n')
      }
    )
  })

  test('answers with onError when the handler throws', async () => {
    await withListener(
      () => Promise.reject(new Error('boom')),
      async (url) => {
        const res = await fetch(url)
        assert.equal(res.status, 500)
        assert.equal(await res.text(), 'failed: Error: boom')
      }
    )
  })

  test('rejects when the port is taken', async () => {
    await withListener(
      () => Promise.resolve(new Response('ok')),
      async (url) => {
        const port = Number(new URL(url).port)
        await assert.rejects(
          listen({ fetch: () => Promise.resolve(new Response()), host: '127.0.0.1', onError: failed, port })
        )
      }
    )
  })
})
