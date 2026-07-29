// Deadlines for every JMAP fetch.
//
// Without one, a stalled Stalwart turns into an indefinitely hung request:
// nginx holds the connection for up to an hour (`proxy_read_timeout 1h`, set
// for long-lived streaming responses), so the caller sees a client-side
// timeout while the server looks healthy. A bounded call fails instead, and a
// failure is something the logs and error tracking can show.
//
// 30 s is generous on purpose: queries over large mailboxes and blob transfers
// are legitimately slow, and this deadline exists to catch a stall, not to
// enforce a latency budget.

const JMAP_TIMEOUT_MS = 30_000

// Bounds the whole exchange — request, response headers, response body. The
// right shape for the calls that read a bounded JSON body before returning.
export const jmapTimeoutSignal = (ms: number = JMAP_TIMEOUT_MS): AbortSignal => AbortSignal.timeout(ms)

// Bounds only the wait for response *headers*. Blob downloads hand the upstream
// body onward as a stream (see blob.ts), so a whole-exchange signal would sever
// a large attachment mid-transfer once the clock ran out. `fetch` resolves as
// soon as the headers land, so clearing the timer there bounds the part that
// can stall — connect, TLS, upstream think-time — and leaves the body alone.
export const fetchWithHeadersDeadline = async (
  input: string,
  init: RequestInit = {},
  ms: number = JMAP_TIMEOUT_MS
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`upstream did not respond within ${ms}ms`)), ms)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
