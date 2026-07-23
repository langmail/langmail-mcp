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

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'StalwartCredentialError'
    this.status = status
  }
}

interface FetchOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * Fetches the user's Stalwart Basic credential from the auth service.
 * Returns `null` when the user has no active mailbox (404); throws
 * {@link StalwartCredentialError} on any other non-200 response.
 */
export async function fetchStalwartCredential(
  userId: string,
  config: AuthServiceConfig,
  options: FetchOptions = {}
): Promise<StalwartCredential | null> {
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
    throw new StalwartCredentialError(`Stalwart credential endpoint request failed: ${message}`)
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
    const detail = (await response.text().catch(() => ''))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
    throw new StalwartCredentialError(
      `Stalwart credential endpoint returned ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status
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
