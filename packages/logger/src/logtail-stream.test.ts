import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Capture every logtail.log(...) call so we can assert the pino → Logtail
// mapping matches what @logtail/pino's transport produced.
interface LogCall {
  context: Record<string, unknown>
  level: string
  message: string
}
const logCalls: LogCall[] = []

// createLogtailStream's only observable use of its arguments is the client it
// constructs, so the constructor arguments are part of the contract: an absent
// endpoint must stay absent rather than become `endpoint: undefined`, which the
// @logtail/node client would read as a configured (empty) endpoint.
interface ConstructorCall {
  options: Record<string, unknown>
  token: string
}
const constructorCalls: ConstructorCall[] = []

let flushCount = 0

// The @logtail/node client retries and burst-protects internally, so
// logtail-stream.ts deliberately swallows rejected log/flush promises. These
// flags are how the suite reaches that path — the real client only rejects
// against a network.
let rejectLogs = false
let rejectFlush = false

let rejectionsHandled = 0

// Counts rejection handlers attached to the promise the client returned, which
// is what lets the tests below assert the guarantee themselves instead of
// leaning entirely on Bun's runner failing a test that leaks an unhandled
// rejection. The counter is synchronous, so it is independent of both the
// runner's behaviour and how long `settleRejections` waits.
//
// `then` is the shadowed method rather than `catch`, deliberately. `forward`
// uses `.catch(...)`, but the language specifies that as
// `Invoke(promise, 'then', «undefined, onRejected»)` — an observable lookup on
// the instance, not an internal slot — so shadowing `then` sees a handler
// attached either way, and the assertion pins the guarantee (a rejection
// handler was attached) rather than the method `forward` happens to reach for.
// Shadowing `catch` would red a correct refactor to `.then(undefined, handler)`.
// Verified under Bun: `.catch(h)` and `.then(undefined, h)` both count 1,
// `.then(onFulfilled)` alone counts 0, and dropping the handler counts 0.
type VoidPromiseThen = Promise<void>['then']

const trackedRejection = (message: string): Promise<void> => {
  const promise: Promise<void> = Promise.reject(new Error(message))
  const attach: VoidPromiseThen = promise.then.bind(promise)
  const counting: VoidPromiseThen = (onFulfilled, onRejected) => {
    // Gated so a plain `.then(onFulfilled)` cannot inflate the count.
    if (typeof onRejected === 'function') {
      rejectionsHandled += 1
    }
    return attach(onFulfilled, onRejected)
  }
  promise.then = counting
  return promise
}

// Runtime stand-in for @logtail/node's Logtail; the production code constructs
// it with (token, options), which a no-arg JS class accepts and ignores.
class FakeLogtail {
  constructor(token: string, options: Record<string, unknown> = {}) {
    constructorCalls.push({ options, token })
  }

  log(message: string, level: string, context: Record<string, unknown>): Promise<void> {
    logCalls.push({ context, level, message })
    return rejectLogs ? trackedRejection('logtail unavailable') : Promise.resolve()
  }

  flush(): Promise<void> {
    flushCount += 1
    return rejectFlush ? trackedRejection('flush failed') : Promise.resolve()
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

// Bypasses JSON.stringify so a test can hand the stream bytes pino would never
// produce (malformed lines, blank lines, a record split across two writes).
const writeRaw = (chunk: Buffer | string): Promise<void> =>
  new Promise((resolve) => {
    stream.write(chunk, () => resolve())
  })

type ExitListener = () => void

const beforeExitListeners = (): ExitListener[] => process.listeners('beforeExit') as ExitListener[]

// createLogtailStream registers one process-level `beforeExit` listener per
// call, so a test that builds its own stream has to take that listener back off
// again — otherwise the suite leaks one per test and Node starts warning at
// eleven. Returns the listeners this call added, so a test can both invoke them
// (that is the flush-on-drain path) and remove them afterwards.
const createStreamWithExitListeners = (token: string, endpoint?: string): ExitListener[] => {
  const before = new Set(beforeExitListeners())
  createLogtailStream(token, endpoint)
  return beforeExitListeners().filter((listener) => !before.has(listener))
}

const removeExitListeners = (listeners: ExitListener[]): void => {
  for (const listener of listeners) {
    process.removeListener('beforeExit', listener)
  }
}

// The guarantee around a rejected client promise: it must not escape `forward`,
// because an unhandled rejection would take down the emitting service. Two
// mechanisms hold it, and both are deliberate. `trackedRejection` above counts
// handler attachment, which is what the tests assert directly; Bun's runner
// then catches a rejection that escapes by any other route, since it fails any
// test that leaks one rather than delivering it to a
// `process.on('unhandledRejection')` listener — a listener here would observe
// nothing, which is why there is no "nothing fired" assertion.
//
// Confirmed by mutation at both `.catch(ignoreRejection)` sites in
// logtail-stream.ts: dropping the one on the `log` call reds the two
// log-rejection tests below, and dropping the one on the drain `flush` reds
// `swallows a rejected flush promise`. Rewriting either as
// `.then(undefined, ignoreRejection)` keeps them green, which is the boundary
// these tests are meant to draw — dropping the handler fails, changing how it
// is attached does not.
//
// An escaped rejection only surfaces once the microtask queue has drained, so
// every test that provokes one yields a macrotask turn before finishing;
// without that the test could end before the runner could notice.
const settleRejections = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 10)
  })

const resetState = (): void => {
  logCalls.length = 0
  constructorCalls.length = 0
  flushCount = 0
  rejectLogs = false
  rejectFlush = false
  rejectionsHandled = 0
}

beforeEach(resetState)

afterEach(resetState)

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
    // `message` is in the fixture so the `ctx.message` assertion below is
    // load-bearing. Without the key it holds whether or not `message` is
    // stripped, and it was the one entry in RESERVED_KEYS that could be deleted
    // with the whole suite staying green.
    await emit({ level: 30, time: 1, msg: 'm', message: 'x', v: 1, service: 'api', userId: 'u-1', count: 3 })

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
    await writeRaw('not json\n')

    expect(logCalls).toHaveLength(0)

    // The length-0 assertion alone is satisfied by a stream that never forwards
    // anything, so show the pipeline survived the malformed line rather than
    // having been broken all along.
    await emit({ level: 30, time: 1, msg: 'after-malformed' })
    expect(logCalls.map((c) => c.message)).toEqual(['after-malformed'])
  })
})

describe('createLogtailStream level mapping between boundaries', () => {
  test('rounds each pino level band up to its Logtail level', async () => {
    await emit({ level: 1, time: 1, msg: 'a' })
    await emit({ level: 15, time: 1, msg: 'a' })
    await emit({ level: 25, time: 1, msg: 'a' })
    await emit({ level: 35, time: 1, msg: 'a' })
    await emit({ level: 45, time: 1, msg: 'a' })
    await emit({ level: 55, time: 1, msg: 'a' })

    expect(logCalls.map((c) => c.level)).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  })

  test('maps a level below pino trace to trace and one above fatal to fatal', async () => {
    await emit({ level: -1, time: 1, msg: 'a' })
    await emit({ level: 1000, time: 1, msg: 'a' })

    expect(logCalls.map((c) => c.level)).toEqual(['trace', 'fatal'])
  })

  // Documents a quirk rather than an intention: every comparison in
  // toLogtailLevel is false against `undefined`, so a record pino never writes
  // (it always sets `level`) would land in BetterStack as a fatal.
  test('reports a record with no level as fatal', async () => {
    await emit({ time: 1, msg: 'levelless' })

    expect(logCalls[0]?.level).toBe('fatal')
  })
})

describe('createLogtailStream dt handling', () => {
  test('omits dt when the record has no time', async () => {
    await emit({ level: 30, msg: 'no-time' })

    // The length assertion is load-bearing: every assertion below is satisfied
    // by absence, so without it a stream that forwarded nothing would pass.
    expect(logCalls).toHaveLength(1)
    expect(logCalls[0]?.context.dt).toBeUndefined()
    expect(logCalls[0]?.context).not.toHaveProperty('dt')
  })

  test('omits dt when time cannot be parsed as a date', async () => {
    await emit({ level: 30, time: 'not-a-date', msg: 'bad-time' })

    expect(logCalls).toHaveLength(1)
    expect(logCalls[0]?.context.dt).toBeUndefined()
  })

  // The in-process stream is deliberately more permissive than @logtail/pino,
  // which only handled string times and so dropped dt for pino's numeric
  // default. Both shapes must now produce a dt.
  test('sets dt from an ISO string time', async () => {
    await emit({ level: 30, time: '2026-06-09T12:00:00.000Z', msg: 'string-time' })

    const dt = logCalls[0]?.context.dt as Date
    expect(dt).toBeInstanceOf(Date)
    expect(dt.toISOString()).toBe('2026-06-09T12:00:00.000Z')
  })

  // A null time is not undefined, so it passes the guard and `new Date(null)`
  // yields a valid date at the unix epoch. Captured as current behaviour.
  test('maps a null time to the unix epoch', async () => {
    await emit({ level: 30, time: null, msg: 'null-time' })

    const dt = logCalls[0]?.context.dt as Date
    expect(dt.toISOString()).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('createLogtailStream message handling', () => {
  test('sends an empty message when neither msg nor message is present', async () => {
    await emit({ level: 30, time: 1, service: 'api' })

    expect(logCalls[0]?.message).toBe('')
    expect(logCalls[0]?.context.service).toBe('api')
  })

  // `msg` is cast to string rather than converted, so a non-string msg reaches
  // the client with its original runtime type. Captured as current behaviour.
  test('passes a non-string msg through without converting it', async () => {
    await emit({ level: 30, time: 1, msg: 42 })

    expect(logCalls[0]?.message).toBe(42 as unknown as string)
  })

  test('keeps message_field off the context when only message is present', async () => {
    await emit({ level: 30, time: 1, message: 'solo' })

    expect(logCalls).toHaveLength(1)
    expect(logCalls[0]?.context).not.toHaveProperty('message_field')
  })
})

describe('createLogtailStream context handling', () => {
  test('preserves nested objects and arrays', async () => {
    await emit({
      level: 30,
      time: 1,
      msg: 'nested',
      err: { message: 'boom', type: 'Error' },
      // Hashes, not addresses: REVIEW.md keeps email addresses out of log
      // lines, and this package exports `hashEmail` so callers can log these
      // instead. A fixture inside the BetterStack forwarder should model the
      // shape callers are meant to send.
      recipientHashes: ['4be15ac83ae8', '49a3135ca77a'],
    })

    const ctx = logCalls[0]?.context ?? {}
    expect(ctx.err).toEqual({ message: 'boom', type: 'Error' })
    expect(ctx.recipientHashes).toEqual(['4be15ac83ae8', '49a3135ca77a'])
  })

  // The tests below are all consequences of one thing: `forward` derives
  // `meta.dt`, then copies every non-reserved record key into that same object.
  // `dt` and `message_field` are not in RESERVED_KEYS, so a record carrying
  // either collides with the field this stream uses for its own purposes.

  // The sharpest of the pinned quirks, and the only one reachable from ordinary
  // pino use with no malformed input: a caller doing `logger.info({ dt }, 'x')`
  // silently replaces the timestamp derived from `time` with its own raw value,
  // even when that value is a string the client cannot read as a time.
  test('lets a dt on the record override the dt derived from time', async () => {
    await emit({ level: 30, time: 1, msg: 'own-dt', dt: 'not-a-date' })

    expect(logCalls).toHaveLength(1)
    expect(logCalls[0]?.context.dt).toBe('not-a-date')
  })

  // `meta.message_field` is assigned after the copy loop, so which value wins
  // depends on whether the record had both `msg` and `message`.
  test('keeps a record message_field when msg is absent but loses it when both are present', async () => {
    await emit({ level: 30, time: 1, message: 'm', message_field: 'mine' })

    expect(logCalls[0]?.context.message_field).toBe('mine')

    logCalls.length = 0
    await emit({ level: 30, time: 1, msg: 'a', message: 'b', message_field: 'mine' })

    expect(logCalls[0]?.context.message_field).toBe('b')
  })

  // Both `__proto__` tests use a raw line rather than `emit`, and that is
  // load-bearing: `__proto__:` in an *object literal* sets the literal's own
  // prototype instead of creating a property (ES2015 B.3.1), so
  // `JSON.stringify` would drop the key and the stream would never see it.
  // Only `JSON.parse` of a real line makes `__proto__` an own property that
  // `Object.keys` yields and the copy loop then assigns.

  // With an object value the assignment reaches `Object.prototype`'s setter, so
  // the value is not discarded — it becomes *this* context object's prototype,
  // readable through the chain while absent from `Object.keys`. The containment
  // is the guarantee worth pinning: `Object.prototype` itself is untouched.
  test('keeps a __proto__ object off the context without polluting Object.prototype', async () => {
    await writeRaw('{"level":30,"time":1,"msg":"proto","__proto__":{"polluted":true}}\n')

    expect(logCalls).toHaveLength(1)
    const ctx = logCalls[0]?.context ?? {}
    expect(Object.keys(ctx)).toEqual(['dt'])
    expect(Object.hasOwn(ctx, '__proto__')).toBe(false)
    expect(Object.hasOwn(ctx, 'polluted')).toBe(false)
    expect(ctx.polluted).toBe(true)
    expect(Object.hasOwn({}, 'polluted')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  // A primitive value takes a third path: the setter returns without doing
  // anything, so the field is dropped outright and no prototype changes.
  test('drops a primitive __proto__ field outright', async () => {
    const line = '{"level":30,"time":1,"msg":"proto","__proto__":"x"}'

    // Pins the fixture rather than only the output, which is the one guard
    // available here. The object-value test above is self-guarding —
    // `ctx.polluted` is `true` only if the key arrived — but a no-op setter and
    // an absent key produce identical contexts, so every assertion below also
    // holds for a line carrying no `__proto__` at all. Without this line the
    // object-literal mistake that broke the first version of these tests would
    // pass unnoticed here.
    expect(Object.hasOwn(JSON.parse(line) as Record<string, unknown>, '__proto__')).toBe(true)

    await writeRaw(`${line}\n`)

    expect(logCalls).toHaveLength(1)
    const ctx = logCalls[0]?.context ?? {}
    expect(Object.keys(ctx)).toEqual(['dt'])
    expect(ctx.polluted).toBeUndefined()
    expect(Object.getPrototypeOf(ctx)).toBe(Object.prototype)
  })

  test('keeps a null field rather than dropping it', async () => {
    await emit({ level: 30, time: 1, msg: 'nulls', threadId: null })

    expect(Object.hasOwn(logCalls[0]?.context ?? {}, 'threadId')).toBe(true)
    expect(logCalls[0]?.context.threadId).toBeNull()
  })
})

describe('createLogtailStream chunk handling', () => {
  test('forwards every record in a multi-line chunk', async () => {
    const lines = [
      JSON.stringify({ level: 30, time: 1, msg: 'first' }),
      JSON.stringify({ level: 40, time: 1, msg: 'second' }),
      JSON.stringify({ level: 50, time: 1, msg: 'third' }),
    ]
    await writeRaw(`${lines.join('\n')}\n`)

    expect(logCalls.map((c) => c.message)).toEqual(['first', 'second', 'third'])
  })

  test('accepts a Buffer chunk', async () => {
    await writeRaw(Buffer.from(`${JSON.stringify({ level: 30, time: 1, msg: 'from-buffer' })}\n`, 'utf8'))

    expect(logCalls.map((c) => c.message)).toEqual(['from-buffer'])
  })

  test('forwards a line with no trailing newline', async () => {
    await writeRaw(JSON.stringify({ level: 30, time: 1, msg: 'unterminated' }))

    expect(logCalls.map((c) => c.message)).toEqual(['unterminated'])
  })

  test('skips blank lines', async () => {
    await writeRaw(`\n\n${JSON.stringify({ level: 30, time: 1, msg: 'after-blanks' })}\n\n`)

    expect(logCalls.map((c) => c.message)).toEqual(['after-blanks'])
  })

  test('forwards the valid lines surrounding a malformed one', async () => {
    const chunk = [
      JSON.stringify({ level: 30, time: 1, msg: 'before' }),
      '{"level":30,"msg":',
      JSON.stringify({ level: 30, time: 1, msg: 'after' }),
    ].join('\n')
    await writeRaw(`${chunk}\n`)

    expect(logCalls.map((c) => c.message)).toEqual(['before', 'after'])
  })

  // `forward` assumes JSON.parse returned an object. A scalar line does not
  // throw, so it slips past the `catch` that discards malformed lines, and with
  // no `level` it falls through toLogtailLevel's default — so a stray `42` is
  // published to BetterStack as an empty *fatal* rather than being skipped. This
  // is where the levelless-record fall-through stops being harmless.
  test('turns a non-object JSON line into an empty fatal', async () => {
    await writeRaw('42\n')

    expect(logCalls).toHaveLength(1)
    expect(logCalls[0]?.level).toBe('fatal')
    expect(logCalls[0]?.message).toBe('')
    expect(logCalls[0]?.context).toEqual({})
  })

  // Worse for a quoted string than for a number: `Object.keys('str')` is the
  // index list, so the characters are spread across the context as 0/1/2.
  test('spreads a JSON string line across the context by character index', async () => {
    await writeRaw('"str"\n')

    expect(logCalls).toHaveLength(1)
    expect(logCalls[0]?.level).toBe('fatal')
    expect(logCalls[0]?.context).toEqual({ 0: 's', 1: 't', 2: 'r' })
  })

  // `null` is the one scalar that is skipped, and only by accident: reading
  // `.time` off it throws, and `write`'s catch discards the line.
  test('drops a JSON null line', async () => {
    await writeRaw('null\n')

    expect(logCalls).toHaveLength(0)

    await emit({ level: 30, time: 1, msg: 'after-null' })
    expect(logCalls.map((c) => c.message)).toEqual(['after-null'])
  })

  // A limitation, captured so a future reassembly fix has something to flip:
  // the stream parses each write in isolation, so a record delivered in two
  // chunks is dropped entirely rather than being buffered and re-joined. Safe
  // in practice only because pino.multistream writes one whole line per call.
  test('drops a record split across two writes', async () => {
    await writeRaw('{"level":30,"time":1,"msg":"split"')
    await writeRaw('}\n')

    expect(logCalls).toHaveLength(0)

    await emit({ level: 30, time: 1, msg: 'after-split' })
    expect(logCalls.map((c) => c.message)).toEqual(['after-split'])
  })
})

describe('createLogtailStream failure handling', () => {
  test('swallows a rejected log promise', async () => {
    rejectLogs = true
    await emit({ level: 30, time: 1, msg: 'will-reject' })
    await settleRejections()

    expect(logCalls).toHaveLength(1)
    expect(rejectionsHandled).toBe(1)
  })

  test('keeps forwarding records after a rejected log promise', async () => {
    rejectLogs = true
    await emit({ level: 30, time: 1, msg: 'rejected' })
    rejectLogs = false
    await emit({ level: 30, time: 1, msg: 'accepted' })
    await settleRejections()

    expect(logCalls.map((c) => c.message)).toEqual(['rejected', 'accepted'])
    expect(rejectionsHandled).toBe(1)
  })

  test('flushes the client when the event loop drains', () => {
    const added = createStreamWithExitListeners('flush-token')
    try {
      expect(added).toHaveLength(1)
      for (const listener of added) {
        listener()
      }
      expect(flushCount).toBe(1)
    } finally {
      removeExitListeners(added)
    }
  })

  test('swallows a rejected flush promise', async () => {
    const added = createStreamWithExitListeners('flush-token')
    try {
      rejectFlush = true
      for (const listener of added) {
        listener()
      }
      await settleRejections()

      expect(flushCount).toBe(1)
      expect(rejectionsHandled).toBe(1)
    } finally {
      removeExitListeners(added)
    }
  })

  // Each stream owns its own client, so each registers its own drain flush
  // rather than sharing one: two streams in a process flush twice, once per
  // client. This is also why every stream here is torn down — the listeners
  // accumulate per call.
  test('registers one independent drain flush per stream', () => {
    const first = createStreamWithExitListeners('flush-token-a')
    const second = createStreamWithExitListeners('flush-token-b')
    try {
      expect(first).toHaveLength(1)
      expect(second).toHaveLength(1)
      expect(first[0]).not.toBe(second[0])

      for (const listener of [...first, ...second]) {
        listener()
      }

      expect(flushCount).toBe(2)
    } finally {
      removeExitListeners([...first, ...second])
    }
  })

  // No SIGINT/SIGTERM handler is registered on purpose: adding a signal
  // listener suppresses Node's default termination and would hang services
  // that have no shutdown handler of their own.
  test('registers no signal handlers', () => {
    const sigintBefore = process.listenerCount('SIGINT')
    const sigtermBefore = process.listenerCount('SIGTERM')
    const added = createStreamWithExitListeners('signal-token')
    try {
      // Pins that a stream was actually built: both counter assertions below
      // also hold against a createLogtailStream that registered nothing at all.
      expect(added).toHaveLength(1)
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore)
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore)
    } finally {
      removeExitListeners(added)
    }
  })
})

describe('createLogtailStream client construction', () => {
  test('passes the source token through to the Logtail client', () => {
    const added = createStreamWithExitListeners('source-token-123')
    try {
      expect(constructorCalls).toHaveLength(1)
      expect(constructorCalls[0]?.token).toBe('source-token-123')
    } finally {
      removeExitListeners(added)
    }
  })

  test('leaves endpoint unset when none is given', () => {
    const added = createStreamWithExitListeners('source-token-123')
    try {
      expect(constructorCalls[0]?.options).toEqual({})
    } finally {
      removeExitListeners(added)
    }
  })

  test('forwards a provided endpoint as a client option', () => {
    const added = createStreamWithExitListeners('source-token-123', 'https://in.example.test')
    try {
      expect(constructorCalls[0]?.options.endpoint).toBe('https://in.example.test')
    } finally {
      removeExitListeners(added)
    }
  })

  // An empty endpoint is falsy, so it is treated as "not configured" rather
  // than overriding the client default with an unusable URL.
  test('treats an empty endpoint as no endpoint', () => {
    const added = createStreamWithExitListeners('source-token-123', '')
    try {
      expect(constructorCalls[0]?.options).toEqual({})
    } finally {
      removeExitListeners(added)
    }
  })
})
