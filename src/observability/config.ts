// Whether this process can actually report anything.
//
// `/run/secrets` is tmpfs, so a reboot empties `mcp.env`: the container comes
// back up and serves normally, but `BETTERSTACK_SOURCE_TOKEN` and
// `BETTERSTACK_ERRORS_DSN` are gone and both log shipping and error tracking
// silently become no-ops. Observability that can be lost without a trace will
// eventually be lost at the moment it is needed, so the state is reported two
// ways: an `error` line at boot (journald-only by construction — the very
// tokens that would ship it are the missing ones) and a boolean pair on
// `/readyz`, which the Better Stack uptime monitor records with every check.
//
// Presence only, never the value. A boolean says "log shipping is configured",
// which is configuration state, not a secret.

import { logger } from '@langmail/logger'

interface ObservabilityConfig {
  // BETTERSTACK_ERRORS_DSN — Sentry-compatible error tracking.
  errorTracking: boolean
  // BETTERSTACK_SOURCE_TOKEN — structured log shipping.
  logShipping: boolean
}

export type ObservabilityStatus = () => ObservabilityConfig

export const observabilityConfig: ObservabilityStatus = () => ({
  errorTracking: Boolean(process.env.BETTERSTACK_ERRORS_DSN),
  logShipping: Boolean(process.env.BETTERSTACK_SOURCE_TOKEN),
})

// Boot-time check. Only meaningful in production — outside it both integrations
// are disabled by design (see packages/logger), so a missing token is normal.
export const logObservabilityConfig = (status: ObservabilityStatus = observabilityConfig): void => {
  if (process.env.NODE_ENV !== 'production') {
    return
  }
  const config = status()
  if (config.errorTracking && config.logShipping) {
    return
  }
  logger.error(
    config,
    'mcp observability degraded: a BETTERSTACK_* secret is missing (did a reboot empty /run/secrets?)'
  )
}
