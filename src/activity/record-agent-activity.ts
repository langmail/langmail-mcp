// Records that a user was active through an agent today: Auth writes one row
// per user, UTC day and surface into `user_activity`, which the metric views
// count (docs/reference/agent-usage-metrics.md). The MCP server calls it
// after every successful tool call (mcp/tool-logging.ts), without awaiting it.
//
// A failed write is logged and dropped: losing a day's activity row must not
// fail the tool call that earned it. The line names only the status, never
// the user id.

import { type AuthServiceConfig } from '@langmail/jmap'
import { logger } from '@langmail/logger'

import { InternalAuthError, postInternal } from '../auth-internal.ts'

export type RecordAgentActivity = (userId: string) => Promise<void>

const AGENT_ACTIVITY_PATH = '/internal/agent-activity'

export const makeAgentActivityRecorder =
  (auth: AuthServiceConfig): RecordAgentActivity =>
  async (userId) => {
    try {
      await postInternal(auth, AGENT_ACTIVITY_PATH, { userId })
    } catch (error) {
      logger.error(
        { status: error instanceof InternalAuthError ? error.status : undefined },
        'mcp agent activity not recorded'
      )
    }
  }

// Without Auth's endpoints the server records nothing (auth-internal.ts
// already logged why).
export const agentActivityRecorderFromEnv = (auth: AuthServiceConfig | undefined): RecordAgentActivity =>
  auth ? makeAgentActivityRecorder(auth) : async () => undefined
