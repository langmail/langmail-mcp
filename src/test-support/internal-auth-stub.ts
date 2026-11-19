// A stand-in for Auth's internal endpoints: records each request and answers
// with what the test hands it.

import { type AuthServiceConfig } from '../jmap/index.ts'

export interface StubRequest {
  authorization: string | null
  body: unknown
  path: string
}

export interface InternalAuthStub {
  auth: AuthServiceConfig
  requests: StubRequest[]
  stop: () => void
}

export const startInternalAuthStub = (answer: (path: string, body: unknown) => Response): InternalAuthStub => {
  const requests: StubRequest[] = []
  const server = Bun.serve({
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      const body: unknown = await req.json()
      requests.push({ authorization: req.headers.get('authorization'), body, path })
      return answer(path, body)
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  return {
    auth: { baseUrl: `http://127.0.0.1:${server.port}`, internalToken: 'internal-token' },
    requests,
    stop: () => server.stop(true),
  }
}
