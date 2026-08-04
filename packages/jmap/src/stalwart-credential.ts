// Client for the auth service's internal stalwart-credential endpoint — the
// decoupling seam between Better Auth (which owns the encrypted mailbox
// password) and per-user JMAP calls. It trades a user id for a ready-made
// `Basic …` Authorization header plus the mailbox address; the same contract
// email-sync's Rust `StalwartCredentialClient` consumes. Lives in this
// package because its output is exactly the `authorization` value every JMAP
// wrapper here takes (consumers: email-agent's poller/writer, daily-brief).
//
//   POST {baseUrl}/internal/stalwart-credential
//   Authorization: Bearer <internalToken>
//   { "userId": "<uuid>" }
//   -> 200 { "authorization": "Basic ...", "address": "user@langmail.me" }
//   -> 404 { "error": "no_active_mailbox" }   (mailbox not provisioned yet)

const STALWART_CREDENTIAL_PATH = '/internal/stalwart-credential'
const DEFAULT_TIMEOUT_MS = 5000

// Statuses that mean "the auth service is momentarily not there", as opposed to
// "the auth service answered and the answer is no". A 502/503/504 is nginx
// reporting it could not reach the upstream at all; 429 is a rate limit that
// clears on its own. Everything else — 401 bad token, 500 undecryptable
// password — is a real answer and must not be retried.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])

// Two retries at 250 ms then 500 ms. Deliberately small: this sits inside a
// poll tick that fans out over every mailbox, so the budget is what a container
// restart costs to ride out, not a substitute for the next tick.
const DEFAULT_RETRIES = 2
const RETRY_BASE_DELAY_MS = 250

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface AuthServiceConfig {
  /** Base URL of the auth service, e.g. `https://auth.langmail.me`. No trailing slash. */
  baseUrl: string
  /** Shared secret for the `Authorization: Bearer` header (`AUTH_INTERNAL_TOKEN`). */
  internalToken: string
}

export interface StalwartCredential {
  /** The user's mailbox address, e.g. `alice@langmail.me`. */
  address: string
  /** Full Authorization header value (`Basic …`) for Stalwart JMAP calls. */
  authorization: string
}

/**
 * Thrown when the credential endpoint fails unexpectedly (transient decrypt
 * failure, bad internal token, network error). A plain 404 — the user has no
 * active mailbox — is NOT an error; it resolves to `null` so callers can skip.
 * No credential material is ever included in the message.
 */
export class StalwartCredentialError extends Error {
  readonly status: number | undefined
  /**
   * The auth service was unreachable rather than unwilling — a network error,
   * a timeout, or one of {@link RETRYABLE_STATUSES}. Such a failure is not
   * specific to the requested user: every concurrent caller hits it at once,
   * so a fan-out caller should abandon the whole pass rather than repeat it
   * per user.
   */
  readonly transient: boolean

  constructor(message: string, status?: number, transient = false) {
    super(message)
    this.name = 'StalwartCredentialError'
    this.status = status
    this.transient = transient
  }
}

interface FetchOptions {
  /** Extra attempts after a transient failure. Defaults to {@link DEFAULT_RETRIES}. */
  retries?: number
  /** Caller-owned abort signal. When set it bounds every attempt, and retries are suppressed. */
  signal?: AbortSignal
  /** Per-attempt deadline. Ignored when `signal` is supplied. */
  timeoutMs?: number
}

/**
 * Fetches the user's Stalwart Basic credential from the auth service.
 * Returns `null` when the user has no active mailbox (404); throws
 * {@link StalwartCredentialError} on any other non-200 response.
 *
 * Transient failures (auth service unreachable, 429/502/503/504) are retried
 * with a short backoff. The auth service is restarted often enough that an
 * un-retried blip costs a whole poll tick across every mailbox at once.
 */
export async function fetchStalwartCredential(
  userId: string,
  config: AuthServiceConfig,
  options: FetchOptions = {}
): Promise<StalwartCredential | null> {
  const attempts = (options.retries ?? DEFAULT_RETRIES) + 1

  let lastError: StalwartCredentialError | undefined
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
    }
    try {
      return await requestCredential(userId, config, options)
    } catch (error) {
      // A non-transient failure is the endpoint's real answer — surface it
      // unchanged. And a caller-supplied signal owns the deadline, so spending
      // more of it on retries is not this function's call.
      if (!(error instanceof StalwartCredentialError && error.transient) || options.signal) {
        throw error
      }
      lastError = error
    }
  }
  // `attempts` is at least 1, so the loop always assigned lastError before
  // falling through; the fallback exists only to satisfy the type.
  throw lastError ?? new StalwartCredentialError('Stalwart credential endpoint was never called')
}

async function requestCredential(
  userId: string,
  config: AuthServiceConfig,
  options: FetchOptions
): Promise<StalwartCredential | null> {
  // A fresh deadline per attempt: one signal hoisted out of the retry loop
  // would already be spent by the time the second attempt ran.
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(`${config.baseUrl}${STALWART_CREDENTIAL_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.internalToken}`,
      },
      body: JSON.stringify({ userId }),
      signal,
    })
  } catch (networkError) {
    const message = networkError instanceof Error ? networkError.message : String(networkError)
    // Connection refused, DNS failure, or our own timeout — the request never
    // got an answer, which is the definition of transient here.
    throw new StalwartCredentialError(`Stalwart credential endpoint request failed: ${message}`, undefined, true)
  }

  if (response.status === 404) {
    // Only the endpoint's own "no mailbox" answer maps to null — a 404 from a
    // misrouted proxy or renamed path must fail loudly instead of silently
    // disabling every JMAP write.
    let body: { error?: unknown } = {}
    try {
      body = (await response.json()) as { error?: unknown }
    } catch {
      // fall through to the throw below
    }
    if (body.error === 'no_active_mailbox') {
      return null
    }
    throw new StalwartCredentialError('Stalwart credential endpoint returned an unexpected 404', 404)
  }
  if (!response.ok) {
    // The status code is the one signal that separates a transient upstream blip
    // (502/503 while the auth service restarts) from a persistent misconfig (401
    // bad internal token, 500 undecryptable password) — yet the pino/Sentry
    // serializer only ships the error *message*, so the `status` field never
    // reaches telemetry. Fold the status and the error body (which carries only
    // `{ error }`, never credential material) into the message so the recurring
    // error is actually triageable.
    const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200)
    throw new StalwartCredentialError(
      `Stalwart credential endpoint returned ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
      RETRYABLE_STATUSES.has(response.status)
    )
  }

  let payload: { address?: unknown; authorization?: unknown }
  try {
    payload = (await response.json()) as { address?: unknown; authorization?: unknown }
  } catch {
    throw new StalwartCredentialError(
      `Stalwart credential endpoint returned a malformed body (status ${response.status})`,
      response.status
    )
  }
  if (typeof payload.authorization !== 'string' || !payload.authorization || typeof payload.address !== 'string') {
    throw new StalwartCredentialError(
      `Stalwart credential endpoint returned no credential (status ${response.status})`,
      response.status
    )
  }

  return { address: payload.address, authorization: payload.authorization }
}
