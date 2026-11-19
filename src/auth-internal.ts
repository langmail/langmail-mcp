// Auth's internal endpoints, the server's only way to Langmail's own data:
// the day's agent-activity row (activity/record-agent-activity.ts) and the
// calendar shares (calendar-feeds/shares.ts, calendar-feeds/live-deps.ts).
// The server holds no database login; Auth does the reads and writes.
//
// They are optional for whoever runs the server. Without AUTH_INTERNAL_TOKEN
// it serves every mail, calendar and contact tool, without the sharing tools,
// share feeds or activity rows.

import { type AuthServiceConfig } from '@langmail/jmap'
import { logger } from '@langmail/logger'

const TIMEOUT_MS = 5000

export interface InternalAuthEnv {
  // AUTH_INTERNAL_TOKEN, the internal endpoints' shared secret.
  authInternalToken?: string
  // Auth's base URL for its /internal/* routes.
  authServiceUrl: string
}

// The endpoints' config, or undefined (logged once, here) without the token.
export const internalAuthFromEnv = (env: InternalAuthEnv): AuthServiceConfig | undefined => {
  if (!env.authInternalToken) {
    logger.warn('AUTH_INTERNAL_TOKEN is not set: no calendar sharing, calendar share feeds or agent activity')
    return
  }
  return { baseUrl: env.authServiceUrl, internalToken: env.authInternalToken }
}

// Thrown on anything but a 2xx answer. It carries the status alone: the
// request body holds the user id, which log lines never do.
export class InternalAuthError extends Error {
  readonly status: number | undefined

  constructor(path: string, status?: number) {
    super(status ? `${path} answered ${status}` : `${path} could not be reached`)
    this.name = 'InternalAuthError'
    this.status = status
  }
}

export const postInternal = async (cfg: AuthServiceConfig, path: string, body: unknown): Promise<Response> => {
  let res: Response
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${cfg.internalToken}`, 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new InternalAuthError(path)
  }
  if (!res.ok) {
    throw new InternalAuthError(path, res.status)
  }
  return res
}
