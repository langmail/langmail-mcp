// Turns a thrown value into the few fields an error log line may carry.
//
// Every line this service logs at `error` level is forwarded off-box twice:
// to Better Stack Log Management (src/logger) and, via pinoIntegration,
// to Better Stack Error Tracking. Upstream error bodies routinely embed the
// mailbox address that produced them (JMAP/CalDAV echo the principal, tool
// results quote event content), and REVIEW.md forbids shipping either. So the
// raw message never goes out verbatim: the class name and status carry the
// triage signal, and the message is redacted and truncated before it leaves.

export interface ErrorDetail {
  errorClass: string
  errorMessage: string
  // Upstream HTTP status when the error carries one (JmapError, CalDavError,
  // UserinfoError all do) — the single most useful triage field after the class.
  status?: number
}

// Deliberately broad: any `local@host.tld`-shaped run is treated as an address,
// including the ones embedded mid-sentence in an upstream error body.
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu
// `Bearer <token>` as it appears in a fetch error or an upstream echo.
const BEARER_RE = /bearer\s+\S+/giu
const MAX_MESSAGE_LENGTH = 200

const redact = (message: string): string => message.replace(BEARER_RE, 'Bearer [redacted]').replace(EMAIL_RE, '[email]')

const truncate = (message: string): string =>
  message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message

const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

export const describeError = (error: unknown): ErrorDetail => {
  if (!(error instanceof Error)) {
    return { errorClass: typeof error, errorMessage: truncate(redact(String(error))) }
  }
  const status = statusOf(error)
  return {
    errorClass: error.name || error.constructor.name,
    errorMessage: truncate(redact(error.message)),
    ...(status === undefined ? {} : { status }),
  }
}
