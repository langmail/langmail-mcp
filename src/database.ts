// The MCP server's one Postgres client, shared by agent-activity recording,
// the calendar share feeds and the calendar sharing tools. It logs in as
// `mcp_activity` (infra/postgres/metrics-access.sql), which may touch those
// two tables and nothing else.

import { createDatabaseClient, type DatabaseClient } from '@langmail/database'
import { logger } from '@langmail/logger'

// Undefined without DATABASE_URL: the server still serves every mail and
// calendar tool, without activity rows or calendar sharing.
export const databaseFromEnv = (databaseUrl: string | undefined): DatabaseClient | undefined => {
  if (!databaseUrl) {
    logger.warn('DATABASE_URL is not set: no agent activity, calendar share feeds or calendar sharing')
    return
  }
  const db = createDatabaseClient(databaseUrl, { max: 4 })
  // An idle client's failure (Postgres restarted, connection reset) arrives
  // as a pool event, not a rejected query; unheard, it would be an uncaught
  // error in the process that serves every tool. Only the SQLSTATE goes out.
  db.$client.on('error', (error: unknown) => {
    logger.error({ pgCode: (error as { code?: unknown } | undefined)?.code }, 'mcp database connection failed')
  })
  return db
}
