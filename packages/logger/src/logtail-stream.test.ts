import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Capture every logtail.log(...) call so we can assert the pino → Logtail
// mapping matches what @logtail/pino's transport produced.
interface LogCall {
  context: Record<string, unknown>
  level: string
  message: string
}
const logCalls: LogCall[] = []

// Runtime stand-in for @logtail/node's Logtail; the production code constructs
// it with (token, options), which a no-arg JS class accepts and ignores.
class FakeLogtail {
  log(message: string, level: string, context: Record<string, unknown>): Promise<void> {
    logCalls.push({ message, level, context })
    return Promise.resolve()
  }

  flush(): Promise<void> {
    return Promise.resolve()
  }
}

mock.module('@logtail/node', () => ({ Logtail: FakeLogtail }))

const { createLogtailStream } = await import('./logtail-stream')

// One stream for the whole suite to avoid stacking beforeExit listeners.
const stream = createLogtailStream('test-token', 'https://example.test')

// Resolve once pino's serialized line has been fully handled by the stream.
const emit = (record: Record<string, unknown>): Promise<void> =>
  new Promise((resolve) => {
    stream.write(`${JSON.stringify(record)}\n`, () => resolve())
  })

beforeEach(() => {
  logCalls.length = 0
})

afterEach(() => {
  logCalls.length = 0
})

describe('createLogtailStream', () => {
  test('maps pino numeric levels to Logtail levels at each boundary', async () => {
    await emit({ level: 10, time: 1, msg: 'a' })
    await emit({ level: 20, time: 1, msg: 'a' })
    await emit({ level: 30, time: 1, msg: 'a' })
    await emit({ level: 40, time: 1, msg: 'a' })
    await emit({ level: 50, time: 1, msg: 'a' })
    await emit({ level: 60, time: 1, msg: 'a' })

    expect(logCalls.map((c) => c.level)).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  })

  test('uses msg as the message and sets dt from time', async () => {
    const time = Date.parse('2026-06-09T12:00:00.000Z')
    await emit({ level: 30, time, msg: 'hello world' })

    expect(logCalls).toHaveLength(1)
    expect(logCalls[0]?.message).toBe('hello world')
    expect(logCalls[0]?.context.dt).toBeInstanceOf(Date)
    const dt = logCalls[0]?.context.dt as Date
    expect(dt.toISOString()).toBe('2026-06-09T12:00:00.000Z')
  })

  test('prefers msg over message and preserves the conflicting message as message_field', async () => {
    await emit({ level: 30, time: 1, msg: 'from-msg', message: 'from-message' })

    expect(logCalls[0]?.message).toBe('from-msg')
    expect(logCalls[0]?.context.message_field).toBe('from-message')
  })

  test('falls back to message when msg is absent', async () => {
    await emit({ level: 30, time: 1, message: 'only-message' })

    expect(logCalls[0]?.message).toBe('only-message')
    expect(logCalls[0]?.context.message_field).toBeUndefined()
  })

  test('forwards extra fields as context but strips reserved keys', async () => {
    await emit({ level: 30, time: 1, msg: 'm', v: 1, service: 'api', userId: 'u-1', count: 3 })

    const ctx = logCalls[0]?.context ?? {}
    expect(ctx.service).toBe('api')
    expect(ctx.userId).toBe('u-1')
    expect(ctx.count).toBe(3)
    expect(ctx.time).toBeUndefined()
    expect(ctx.level).toBeUndefined()
    expect(ctx.v).toBeUndefined()
    expect(ctx.msg).toBeUndefined()
    expect(ctx.message).toBeUndefined()
  })

  test('ignores malformed lines without throwing', async () => {
    await new Promise<void>((resolve) => {
      stream.write('not json\n', () => resolve())
    })

    expect(logCalls).toHaveLength(0)
  })
})
