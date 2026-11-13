// Records that a user was active through an agent today: one row per user,
// UTC day and surface in `user_activity`, which the metric views in the
// `metrics` schema count (docs/reference/agent-usage-metrics.md). The MCP
// server calls it after every successful tool call (mcp/tool-logging.ts); the
// table's primary key and ON CONFLICT DO NOTHING keep repeated calls on one
// day to one row.
//
// Production connects as `mcp_activity`, which may only INSERT into this
// table (infra/postgres/metrics-access.sql) — so no RETURNING here, and no
// read of any kind.
//
// A failed write is logged and dropped: losing a day's activity row must not
// fail the tool call that earned it. The line names only the Postgres error
// code: drizzle's message quotes the query parameters, the user id among
// them, and log lines leave the box free of user ids.

import { createDatabaseClient, type DatabaseClient } from '@langmail/database'
import { user_activity } from '@langmail/database/schema'
import { logger } from '@langmail/logger'

export type RecordAgentActivity = (userId: string) => Promise<void>

// drizzle wraps the driver's error; the `pg` error with its SQLSTATE is the cause.
const postgresCode = (error: unknown): string | undefined => {
  const cause = error instanceof Error ? error.cause : undefined
  const code = (cause as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

const utcDay = (now: Date): string => now.toISOString().slice(0, 10)

export const makeAgentActivityRecorder =
  (db: DatabaseClient, now: () => Date = () => new Date()): RecordAgentActivity =>
  async (userId) => {
    try {
      await db
        .insert(user_activity)
        .values({ day: utcDay(now()), surface: 'mcp', user_id: userId })
        .onConflictDoNothing()
    } catch (error) {
      logger.error({ pgCode: postgresCode(error) }, 'mcp agent activity not recorded')
    }
  }

// Without DATABASE_URL the server still serves every tool, it just records
// nothing — so an image deployed before its credential is in mcp.env keeps
// working. The warning says why the metrics stay empty.
export const agentActivityRecorderFromEnv = (databaseUrl: string | undefined): RecordAgentActivity => {
  if (!databaseUrl) {
    logger.warn('DATABASE_URL is not set: agent activity is not recorded')
    return async () => undefined
  }
  const db = createDatabaseClient(databaseUrl, { max: 2 })
  // An idle client's failure (Postgres restarted, connection reset) arrives
  // as a pool event, not a rejected query; unheard, it would be an uncaught
  // error in the process that serves every tool.
  db.$client.on('error', (error: unknown) => {
    logger.error({ pgCode: (error as { code?: unknown } | undefined)?.code }, 'mcp agent activity connection failed')
  })
  return makeAgentActivityRecorder(db)
}
