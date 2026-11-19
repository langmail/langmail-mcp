import { afterEach, describe, expect, test } from 'bun:test'

import { type InternalAuthStub, startInternalAuthStub } from '../test-support/internal-auth-stub.ts'
import { agentActivityRecorderFromEnv, makeAgentActivityRecorder } from './record-agent-activity.ts'

describe('agent activity record', () => {
  let stub: InternalAuthStub | undefined
  afterEach(() => stub?.stop())

  test("asks Auth to record the user's activity, with the internal token", async () => {
    stub = startInternalAuthStub(() => new Response(null, { status: 204 }))
    await makeAgentActivityRecorder(stub.auth)('user-1')
    expect(stub.requests).toEqual([
      { authorization: 'Bearer internal-token', body: { userId: 'user-1' }, path: '/internal/agent-activity' },
    ])
  })

  test('a failed write does not throw', async () => {
    stub = startInternalAuthStub(() => new Response(null, { status: 500 }))
    await makeAgentActivityRecorder(stub.auth)('user-1')
    await makeAgentActivityRecorder({ baseUrl: 'http://127.0.0.1:1', internalToken: 'x' })('user-1')
  })

  test("records nothing without Auth's endpoints", async () => {
    await agentActivityRecorderFromEnv(undefined)('user-1')
  })
})
