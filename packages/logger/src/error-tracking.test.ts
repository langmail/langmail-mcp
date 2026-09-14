import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Capture what the Sentry SDK receives; initErrorTracking's whole job is
// assembling these two calls, so the options object is the behaviour under test.
interface InitOptions {
  dsn: string
  enabled: boolean
  environment: string
  integrations: { name: string }[]
  sendDefaultPii: boolean
}

const initCalls: InitOptions[] = []
const tagCalls: { key: string; value: string }[] = []
const pinoIntegrationOptions: unknown[] = []

mock.module('@sentry/node', () => ({
  contextLinesIntegration: () => ({ name: 'ContextLines' }),
  init: (options: InitOptions) => {
    initCalls.push(options)
  },
  nodeContextIntegration: () => ({ name: 'NodeContext' }),
  pinoIntegration: (options: unknown) => {
    pinoIntegrationOptions.push(options)
    return { name: 'Pino' }
  },
  setTag: (key: string, value: string) => {
    tagCalls.push({ key, value })
  },
  withScope: () => undefined,
}))

const { initErrorTracking } = await import('./error-tracking')

// initErrorTracking reads process.env at call time, so each case swaps the two
// variables it cares about and restores them afterwards.
const initWithEnv = (env: { dsn?: string; nodeEnv?: string }, serviceName = 'test-service'): InitOptions => {
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

  const options = initCalls.at(-1)
  if (!options) {
    throw new Error('initErrorTracking did not call init()')
  }
  return options
}

beforeEach(() => {
  initCalls.length = 0
  tagCalls.length = 0
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

  test('stays disabled in production when no DSN is configured', () => {
    // The DSN is what silences the client here: `enabled` still tracks
    // NODE_ENV alone, so an unconfigured production service reports nowhere.
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

    expect(options.integrations.map((integration) => integration.name)).toEqual(['NodeContext', 'ContextLines', 'Pino'])
  })

  test('captures only error-level pino records', () => {
    initWithEnv({ nodeEnv: 'production' })

    expect(pinoIntegrationOptions).toEqual([{ error: { levels: ['error'] } }])
  })

  test('tags the service name after initialising', () => {
    initWithEnv({ nodeEnv: 'production' }, 'email-agent')

    expect(tagCalls).toEqual([{ key: 'service', value: 'email-agent' }])
  })

  test('tags whatever service name it is given, including an empty one', () => {
    initWithEnv({ nodeEnv: 'production' }, '')

    expect(tagCalls).toEqual([{ key: 'service', value: '' }])
  })
})
