import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { type NodeOptions } from '@sentry/node'

// initErrorTracking's whole job is assembling the Sentry init options and
// tagging the service, so both calls land in one ordered log: their relative
// order is part of the behaviour (a tag set before init is dropped).
type SentryCall = { kind: 'init'; options: NodeOptions } | { kind: 'setTag'; key: string; value: string }

const calls: SentryCall[] = []
const pinoIntegrationOptions: unknown[] = []

mock.module('@sentry/node', () => ({
  contextLinesIntegration: () => ({ name: 'ContextLines' }),
  init: (options: NodeOptions) => {
    calls.push({ kind: 'init', options })
  },
  nodeContextIntegration: () => ({ name: 'NodeContext' }),
  pinoIntegration: (options: unknown) => {
    pinoIntegrationOptions.push(options)
    return { name: 'Pino' }
  },
  setTag: (key: string, value: string) => {
    calls.push({ kind: 'setTag', key, value })
  },
  withScope: () => undefined,
}))

const { initErrorTracking, withScope } = await import('./error-tracking')

const isInit = (call: SentryCall): call is Extract<SentryCall, { kind: 'init' }> => call.kind === 'init'

// initErrorTracking reads process.env at call time, so each case swaps the two
// variables it cares about and restores them afterwards.
const initWithEnv = (env: { dsn?: string; nodeEnv?: string }, serviceName = 'test-service'): NodeOptions => {
  const before = calls.length
  const originalDsn = process.env.BETTERSTACK_ERRORS_DSN
  const originalNodeEnv = process.env.NODE_ENV

  try {
    if (env.dsn === undefined) {
      delete process.env.BETTERSTACK_ERRORS_DSN
    } else {
      process.env.BETTERSTACK_ERRORS_DSN = env.dsn
    }
    if (env.nodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = env.nodeEnv
    }

    initErrorTracking(serviceName)
  } finally {
    if (originalDsn === undefined) {
      delete process.env.BETTERSTACK_ERRORS_DSN
    } else {
      process.env.BETTERSTACK_ERRORS_DSN = originalDsn
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
  }

  // One call in, exactly one init out — so a double-init regression can't hide
  // behind "read the most recent options".
  const inits = calls.slice(before).filter(isInit)
  expect(inits).toHaveLength(1)
  const options = inits[0]?.options
  if (!options) {
    throw new Error('initErrorTracking did not call init()')
  }
  return options
}

// The source passes a static array; a function form would mean the assertions
// below are inspecting something other than what ships.
const integrationNames = (options: NodeOptions): string[] => {
  const { integrations } = options
  if (!Array.isArray(integrations)) {
    throw new Error('expected init() to receive a static integrations array')
  }
  return integrations.map((integration) => integration.name)
}

beforeEach(() => {
  calls.length = 0
  pinoIntegrationOptions.length = 0
})

describe('initErrorTracking', () => {
  test('forwards the Better Stack DSN verbatim', () => {
    const options = initWithEnv({
      dsn: 'https://token@errors.example.com/42',
      nodeEnv: 'production',
    })

    expect(options.dsn).toBe('https://token@errors.example.com/42')
  })

  test('degrades to an empty DSN when the variable is unset', () => {
    const options = initWithEnv({ nodeEnv: 'production' })

    expect(options.dsn).toBe('')
  })

  test('degrades to an empty DSN when the variable is blank', () => {
    const options = initWithEnv({ dsn: '', nodeEnv: 'production' })

    expect(options.dsn).toBe('')
  })

  test('enables the client only in production', () => {
    expect(initWithEnv({ nodeEnv: 'production' }).enabled).toBe(true)
    expect(initWithEnv({ nodeEnv: 'development' }).enabled).toBe(false)
    expect(initWithEnv({ nodeEnv: 'test' }).enabled).toBe(false)
    expect(initWithEnv({ nodeEnv: 'staging' }).enabled).toBe(false)
  })

  test('stays enabled in production without a DSN, leaving the empty DSN to no-op the client', () => {
    // `enabled` tracks NODE_ENV alone, so an unconfigured production service
    // still gets an enabled client — it is the empty DSN that silences it.
    const options = initWithEnv({ nodeEnv: 'production' })

    expect(options.enabled).toBe(true)
    expect(options.dsn).toBe('')
  })

  test('reports the environment from NODE_ENV', () => {
    expect(initWithEnv({ nodeEnv: 'production' }).environment).toBe('production')
    expect(initWithEnv({ nodeEnv: 'staging' }).environment).toBe('staging')
  })

  test('defaults the environment to development when NODE_ENV is unset or blank', () => {
    expect(initWithEnv({}).environment).toBe('development')
    expect(initWithEnv({ nodeEnv: '' }).environment).toBe('development')
  })

  test('never sends default PII', () => {
    expect(initWithEnv({ nodeEnv: 'production' }).sendDefaultPii).toBe(false)
    expect(initWithEnv({ nodeEnv: 'development' }).sendDefaultPii).toBe(false)
  })

  test('wires node context, context lines and pino integrations', () => {
    const options = initWithEnv({ nodeEnv: 'production' })

    expect(integrationNames(options)).toEqual(['NodeContext', 'ContextLines', 'Pino'])
  })

  test('captures only error-level pino records', () => {
    initWithEnv({ nodeEnv: 'production' })

    expect(pinoIntegrationOptions).toEqual([{ error: { levels: ['error'] } }])
  })

  test('tags the service name after init, so the tag lands on an initialised client', () => {
    initWithEnv({ nodeEnv: 'production' }, 'email-agent')

    expect(calls.map((call) => call.kind)).toEqual(['init', 'setTag'])
    expect(calls.at(-1)).toEqual({ kind: 'setTag', key: 'service', value: 'email-agent' })
  })

  test('tags whatever service name it is given, including an empty one', () => {
    initWithEnv({ nodeEnv: 'production' }, '')

    expect(calls.at(-1)).toEqual({ kind: 'setTag', key: 'service', value: '' })
  })
})

describe('@sentry/node re-exports', () => {
  test('re-exports withScope for package consumers', () => {
    expect(typeof withScope).toBe('function')
  })
})
