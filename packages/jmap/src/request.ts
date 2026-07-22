// Shared JMAP request plumbing: POST a method-call batch and pick a single
// method response out of the batch. Extracted from email.ts when the Sieve
// wrappers became the second consumer.

import { JmapError } from './session.ts'
import { type JmapRequest, type JmapResponse } from './types.ts'

export interface JmapCall {
  apiUrl: string
  // Full Authorization header value (`Bearer …` or `Basic …`) — the wrappers
  // never mint or wrap credentials. MCP builds it via `bearerAuthorization`;
  // the email-agent forwards the `Basic` value the auth service's
  // stalwart-credential endpoint returns.
  authorization: string
}

export const jmapCall = async <T extends JmapResponse>(ctx: JmapCall, body: JmapRequest): Promise<T> => {
  const res = await fetch(ctx.apiUrl, {
    body: JSON.stringify(body),
    headers: {
      authorization: ctx.authorization,
      'content-type': 'application/json',
    },
    method: 'POST',
  })
  if (res.status !== 200) {
    throw new JmapError(res.status, `jmap request returned ${res.status}`)
  }
  return (await res.json()) as T
}

export const methodResponse = <T>(resp: JmapResponse, name: string, callId: string): T => {
  const entry = resp.methodResponses.find(([n, , id]) => n === name && id === callId)
  if (!entry) {
    // RFC 8620 §3.6.2: a failed method call is answered with an `error`
    // response under the same call id. Surface its type so callers can
    // recover from expected conditions (e.g. cannotCalculateChanges →
    // reseed the poll cursor).
    const err = resp.methodResponses.find(([n, , id]) => n === 'error' && id === callId)
    if (err) {
      const detail = err[1] as { description?: string; type?: string }
      throw new JmapError(200, `jmap method error for ${name}/${callId}: ${detail.type ?? 'unknown'}`, detail.type)
    }
    throw new JmapError(200, `missing method response for ${name}/${callId}`)
  }
  return entry[1] as T
}
