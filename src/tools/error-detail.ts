import { JmapError } from '../jmap/index.ts'

// A log-safe description of a failed JMAP call. JmapError messages are
// status-only; anything else is reduced to its name so a fetch-level error
// can't leak a URL that embeds the accountId (REVIEW.md: no user IDs in logs).
export const errorDetail = (err: unknown): string => {
  if (err instanceof JmapError) {
    return err.message
  }
  return err instanceof Error ? err.name : 'unknown'
}
