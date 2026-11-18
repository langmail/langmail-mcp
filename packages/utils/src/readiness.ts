// Dependency-aware readiness shared by the auth and MCP services. /healthz
// proves the process is up; /readyz proves it can actually reach its
// dependencies. Each check resolves with a human detail string on success and
// throws on failure; the runner applies a per-check timeout and caches a ready
// aggregate.

export interface ReadyResult {
  checks: Record<string, string>
  ready: boolean
}

// Receives the per-check timeout so fetch-based checks can abort the socket.
export type Check = (timeoutMs: number) => Promise<string>

export interface ReadinessOptions {
  now?: () => number
  timeoutMs?: number
  ttlMs?: number
}

const DEFAULT_TTL_MS = 10_000
const DEFAULT_TIMEOUT_MS = 3000

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
  // clearTimeout so a fast check never leaves a dangling timer (which would
  // keep `bun test` alive past the assertion).
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export const createReadiness = (
  checks: Record<string, Check>,
  opts: ReadinessOptions = {}
): (() => Promise<ReadyResult>) => {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = opts.now ?? Date.now
  let cached: { at: number; result: ReadyResult } | null = null

  return async () => {
    const at = now()
    // Cache only a ready result. A not-ready one is recomputed on the next
    // request: Better Stack confirms an incident when several regions agree
    // within seconds, so one slow probe served from cache to every region
    // looked like a real outage (#1282, #1306).
    if (cached && at - cached.at < ttlMs) {
      return cached.result
    }
    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          const detail = await withTimeout(check(timeoutMs), timeoutMs)
          return { name, ok: true, detail: detail || 'ok' }
        } catch (error) {
          return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
        }
      })
    )
    const result: ReadyResult = { ready: true, checks: {} }
    for (const { name, ok, detail } of entries) {
      result.checks[name] = detail
      if (!ok) {
        result.ready = false
      }
    }
    cached = result.ready ? { at, result } : null
    return result
  }
}

// `details` is reported alongside the dependency checks without affecting the
// verdict. MCP passes its observability-config presence pair, which the uptime
// monitor records with every check so a secrets-less boot is visible from an
// incident body, not a VM login.
export const readyzResponse = (result: ReadyResult, details: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ status: result.ready ? 'ready' : 'not_ready', checks: result.checks, ...details }), {
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
    status: result.ready ? 200 : 503,
  })
