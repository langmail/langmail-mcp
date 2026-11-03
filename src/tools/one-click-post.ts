// The one outward HTTP request on the MCP surface: an RFC 8058 one-click
// unsubscribe POST to a URL the *sender* wrote. The sender also controls that
// host's DNS, so the address check runs inside the connection's own DNS
// lookup — the IP that is checked is the IP that is dialled, and a rebinding
// answer between a check and a connect cannot slip through. Every redirect
// hop is a new request through the same guard, and must be https too.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'

// Ranges a sender-supplied URL must never reach: this host, the private
// network, the cloud metadata endpoint, and every reserved or translated
// range that can lead back into them.
const BLOCKED = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6')
}

const IPV4_MAPPED_RE = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu

export const isBlockedAddress = (address: string): boolean => {
  const mapped = IPV4_MAPPED_RE.exec(address)?.[1]
  if (mapped) {
    return BLOCKED.check(mapped, 'ipv4')
  }
  const family = isIP(address)
  if (family === 0) {
    return true
  }
  return BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`${host} resolves to a private or internal address`)
    this.name = 'BlockedAddressError'
  }
}

export type Resolve = (host: string) => Promise<LookupAddress[]>

const systemResolve: Resolve = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)))
  })

type LookupCallback = (err: Error | null, address?: string | LookupAddress[], family?: number) => void

// A `lookup` for https.request that refuses the whole connection when any
// address the name resolves to is internal: a name with one public and one
// private record could otherwise be dialled on the private one.
export const guardedLookup =
  (resolve: Resolve) =>
  (host: string, opts: { all?: boolean } | number | undefined, cb: LookupCallback): void => {
    resolve(host)
      .then((addresses) => {
        if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
          cb(new BlockedAddressError(host))
          return
        }
        if (typeof opts === 'object' && opts?.all) {
          cb(null, addresses)
          return
        }
        const [first] = addresses
        cb(null, first?.address, first?.family)
      })
      .catch((err: unknown) => cb(err instanceof Error ? err : new Error(String(err))))
  }

export interface HopResponse {
  body: string
  location: string | null
  status: number
}

export type SendHop = (url: string, method: 'GET' | 'POST') => Promise<HopResponse>

const TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 16_384
const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click'

// One request, nothing followed. The body is read up to a cap; a sender's
// endpoint has no business sending more than a confirmation page.
export const makeSendHop =
  (resolve: Resolve = systemResolve): SendHop =>
  (url, method) =>
    new Promise((resolvePromise, reject) => {
      const req = https.request(
        url,
        {
          headers: {
            'user-agent': 'Langmail-Unsubscribe/1.0',
            ...(method === 'POST'
              ? { 'content-length': String(ONE_CLICK_BODY.length), 'content-type': 'application/x-www-form-urlencoded' }
              : {}),
          },
          lookup: guardedLookup(resolve) as unknown as https.RequestOptions['lookup'],
          method,
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            if (size < MAX_BODY_BYTES) {
              chunks.push(chunk)
              size += chunk.length
            }
          })
          res.on('end', () =>
            resolvePromise({
              body: Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8'),
              location: typeof res.headers.location === 'string' ? res.headers.location : null,
              status: res.statusCode ?? 0,
            })
          )
          res.on('error', reject)
        }
      )
      req.on('timeout', () => req.destroy(new Error(`no answer within ${TIMEOUT_MS / 1000} seconds`)))
      req.on('error', reject)
      req.end(method === 'POST' ? ONE_CLICK_BODY : undefined)
    })

export type OneClickOutcome =
  | { body: string; host: string; kind: 'response'; status: number }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string }

const MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// POST `List-Unsubscribe=One-Click` to the URL, following at most three
// redirects. 307/308 repeat the POST (the RFC 7231 rule); 301/302/303 turn
// into a GET, as browsers do. Every hop must be https and pass the guard.
const isBlockedError = (err: unknown): err is Error =>
  err instanceof BlockedAddressError || (err instanceof Error && err.name === 'BlockedAddressError')

// One hop: the https check, then the request, with a thrown error turned into
// an outcome. A HopResponse means "go on".
const runHop = async (
  current: string,
  hop: number,
  method: 'GET' | 'POST',
  sendHop: SendHop
): Promise<{ res: HopResponse; target: URL } | OneClickOutcome> => {
  let target: URL
  try {
    target = new URL(current)
  } catch {
    return { kind: 'refused', reason: `the link is not a valid URL (${current})` }
  }
  if (target.protocol !== 'https:') {
    return {
      kind: 'refused',
      reason: hop === 0 ? 'the link is not https' : `the sender redirected to a non-https address (${target.protocol})`,
    }
  }
  try {
    return { res: await sendHop(target.href, method), target }
  } catch (err) {
    if (isBlockedError(err)) {
      return { kind: 'refused', reason: err.message }
    }
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

// POST `List-Unsubscribe=One-Click` to the URL, following at most three
// redirects. 307/308 repeat the POST (the RFC 7231 rule); 301/302/303 turn
// into a GET, as browsers do. Every hop must be https and pass the guard.
export const postOneClick = async (url: string, sendHop: SendHop): Promise<OneClickOutcome> => {
  let current = url
  let method: 'GET' | 'POST' = 'POST'
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const step = await runHop(current, hop, method, sendHop)
    if ('kind' in step) {
      return step
    }
    const { res, target } = step
    if (!(REDIRECT_STATUSES.has(res.status) && res.location)) {
      return { body: res.body, host: target.host, kind: 'response', status: res.status }
    }
    current = new URL(res.location, target).href
    if (res.status !== 307 && res.status !== 308) {
      method = 'GET'
    }
  }
  return { kind: 'failed', reason: `the sender redirected more than ${MAX_REDIRECTS} times` }
}
