import { describe, expect, test } from 'bun:test'

import {
  BlockedAddressError,
  guardedLookup,
  type HopResponse,
  isBlockedAddress,
  makeSendHop,
  postOneClick,
  type SendHop,
} from './one-click-post.ts'

describe('isBlockedAddress', () => {
  test.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2002:a00:1::1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true)
  })

  test.each(['93.184.215.14', '1.1.1.1', '2606:4700:4700::1111', '::ffff:1.1.1.1'])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false)
  })
})

describe('guardedLookup', () => {
  const run = (addresses: { address: string; family: number }[], all: boolean) =>
    new Promise<{ err: Error | null; result: unknown }>((resolve) => {
      guardedLookup(() => Promise.resolve(addresses))('news.example.com', { all }, (err, result) =>
        resolve({ err, result })
      )
    })

  test('refuses a name with any internal address, even beside a public one', async () => {
    const { err } = await run(
      [
        { address: '93.184.215.14', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
      true
    )
    expect(err).toBeInstanceOf(BlockedAddressError)
  })

  test('hands public addresses through in the shape asked for', async () => {
    const addresses = [{ address: '93.184.215.14', family: 4 }]
    expect((await run(addresses, true)).result).toEqual(addresses)
    expect((await run(addresses, false)).result).toBe('93.184.215.14')
  })
})

describe('makeSendHop', () => {
  test('a host that resolves to loopback is refused before any connection', async () => {
    const hop = makeSendHop(() => Promise.resolve([{ address: '127.0.0.1', family: 4 }]))
    expect(await postOneClick('https://rebind.example.com/u', hop)).toEqual({
      kind: 'refused',
      reason: 'rebind.example.com resolves to a private or internal address',
    })
  })
})

const scripted = (responses: Record<string, HopResponse | Error>) => {
  const calls: [string, string][] = []
  const hop: SendHop = (url, method) => {
    calls.push([url, method])
    const r = responses[url]
    if (!r) {
      return Promise.reject(new Error(`unexpected ${url}`))
    }
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r)
  }
  return { calls, hop }
}

describe('postOneClick', () => {
  test('POSTs once and returns the response', async () => {
    const { calls, hop } = scripted({
      'https://news.example.com/u': { body: 'ok', location: null, status: 202 },
    })
    expect(await postOneClick('https://news.example.com/u', hop)).toEqual({
      body: 'ok',
      host: 'news.example.com',
      kind: 'response',
      status: 202,
    })
    expect(calls).toEqual([['https://news.example.com/u', 'POST']])
  })

  test('refuses a non-https link without calling it', async () => {
    const { calls, hop } = scripted({})
    expect(await postOneClick('http://news.example.com/u', hop)).toEqual({
      kind: 'refused',
      reason: 'the link is not https',
    })
    expect(calls).toEqual([])
  })

  test('307 repeats the POST, 302 turns into a GET', async () => {
    const { calls, hop } = scripted({
      'https://a.example.com/u': { body: '', location: 'https://b.example.com/u', status: 307 },
      'https://b.example.com/u': { body: '', location: '/done', status: 302 },
      'https://b.example.com/done': { body: 'Bye', location: null, status: 200 },
    })
    const out = await postOneClick('https://a.example.com/u', hop)
    expect(out).toMatchObject({ host: 'b.example.com', kind: 'response', status: 200 })
    expect(calls).toEqual([
      ['https://a.example.com/u', 'POST'],
      ['https://b.example.com/u', 'POST'],
      ['https://b.example.com/done', 'GET'],
    ])
  })

  test('a redirect to http is refused', async () => {
    const { hop } = scripted({
      'https://a.example.com/u': { body: '', location: 'http://a.example.com/u', status: 301 },
    })
    expect(await postOneClick('https://a.example.com/u', hop)).toEqual({
      kind: 'refused',
      reason: 'the sender redirected to a non-https address (http:)',
    })
  })

  test('a redirect into an internal address is refused by the guard', async () => {
    const { hop } = scripted({
      'https://a.example.com/u': { body: '', location: 'https://internal.example.com/x', status: 307 },
      'https://internal.example.com/x': new BlockedAddressError('internal.example.com'),
    })
    expect(await postOneClick('https://a.example.com/u', hop)).toEqual({
      kind: 'refused',
      reason: 'internal.example.com resolves to a private or internal address',
    })
  })

  test('a network error is reported as failed', async () => {
    const { hop } = scripted({ 'https://a.example.com/u': new Error('connect ECONNREFUSED') })
    expect(await postOneClick('https://a.example.com/u', hop)).toEqual({
      kind: 'failed',
      reason: 'connect ECONNREFUSED',
    })
  })

  test('stops after three redirects', async () => {
    const { hop } = scripted({
      'https://a.example.com/1': { body: '', location: '/2', status: 307 },
      'https://a.example.com/2': { body: '', location: '/3', status: 307 },
      'https://a.example.com/3': { body: '', location: '/4', status: 307 },
      'https://a.example.com/4': { body: '', location: '/5', status: 307 },
    })
    expect(await postOneClick('https://a.example.com/1', hop)).toEqual({
      kind: 'failed',
      reason: 'the sender redirected more than 3 times',
    })
  })
})
