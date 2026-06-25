// Dependency-aware readiness for the MCP resource server. /healthz proves the
// process is up; /readyz proves it can actually reach its dependencies. Each
// check resolves with a human detail string on success and throws on failure;
// the runner applies a per-check timeout and caches the aggregate result.

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
    // Cache the whole aggregate — including a not-ready result — for the TTL, so a burst of smoke retries triggers at most one real dependency check.
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
    cached = { at, result }
    return result
  }
}

export const readyzResponse = (result: ReadyResult): Response =>
  new Response(JSON.stringify({ status: result.ready ? 'ready' : 'not_ready', checks: result.checks }), {
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
    status: result.ready ? 200 : 503,
  })

const TRAILING_SLASHES_RE = /\/+$/u

// Reachability of Stalwart's userinfo endpoint — the exact call the auth
// middleware makes per token. Any HTTP response (the expected 401) means the
// egress path is alive; a thrown socket error / timeout means it is not.
export const stalwartReachable =
  (stalwartUrl: string): Check =>
  async (timeoutMs) => {
    const base = stalwartUrl.replace(TRAILING_SLASHES_RE, '')
    const res = await fetch(`${base}/auth/userinfo`, { signal: AbortSignal.timeout(timeoutMs) })
    return `HTTP ${res.status}`
  }
