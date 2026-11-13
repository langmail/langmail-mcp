import { describe, expect, test } from 'bun:test'

import { logObservabilityConfig, observabilityConfig } from './config.ts'

const withEnv = <T>(patch: Record<string, string | undefined>, fn: () => T): T => {
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]))
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
  apply(patch)
  try {
    return fn()
  } finally {
    apply(previous)
  }
}

describe('observabilityConfig', () => {
  test('reports presence, never the value', () => {
    const config = withEnv(
      {
        BETTERSTACK_ERRORS_DSN: 'https://tok@host/1',
        BETTERSTACK_SOURCE_TOKEN: undefined,
        DATABASE_URL: 'postgresql://mcp_activity:secret@db.example.com/langmail',
      },
      () => observabilityConfig()
    )
    expect(config).toEqual({ activityRecording: true, errorTracking: true, logShipping: false })
  })
})

describe('logObservabilityConfig', () => {
  test('stays quiet outside production, where both integrations are off by design', () => {
    let calls = 0
    withEnv({ NODE_ENV: 'development' }, () =>
      logObservabilityConfig(() => {
        calls += 1
        return { activityRecording: false, errorTracking: false, logShipping: false }
      })
    )
    expect(calls).toBe(0)
  })

  test('checks the configuration in production', () => {
    let calls = 0
    withEnv({ NODE_ENV: 'production' }, () =>
      logObservabilityConfig(() => {
        calls += 1
        return { activityRecording: false, errorTracking: false, logShipping: false }
      })
    )
    expect(calls).toBe(1)
  })
})
