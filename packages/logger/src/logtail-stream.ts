import { Writable } from 'node:stream'
import { Logtail } from '@logtail/node'
import { type Context, type ILogLevel, type ILogtailNodeOptions, LogLevel } from '@logtail/types'

// Keys pino puts on every record that should not be forwarded as Logtail
// context. Mirrors the exclusion list in `@logtail/pino`'s transport.
const RESERVED_KEYS = new Set(['time', 'msg', 'message', 'level', 'v'])

// The @logtail/node client retries and burst-protects internally, so a rejected
// log/flush promise here is expected and must never surface as an unhandled
// rejection or take down the emitting process.
const ignoreRejection = (): void => undefined

/**
 * Map a numeric pino level to a Logtail `LogLevel`.
 *
 * Replicates `getLogLevel` from `@logtail/pino` so that re-implementing the
 * transport as an in-process stream produces identical levels in BetterStack.
 */
const toLogtailLevel = (level: number): LogLevel => {
  if (level <= 10) {
    return LogLevel.Trace
  }
  if (level <= 20) {
    return LogLevel.Debug
  }
  if (level <= 30) {
    return LogLevel.Info
  }
  if (level <= 40) {
    return LogLevel.Warn
  }
  if (level <= 50) {
    return LogLevel.Error
  }
  return LogLevel.Fatal
}

/**
 * Translate a single parsed pino log record into a `logtail.log(...)` call,
 * mirroring `@logtail/pino`'s record handling.
 */
const forward = (logtail: Logtail, record: Record<string, unknown>): void => {
  const meta: Context = {}

  // pino's default timestamp is epoch milliseconds (a number). Unlike the
  // original @logtail/pino guard (which only handled string times and so
  // dropped dt for the numeric default), set dt whenever the time parses.
  if (record.time !== undefined) {
    const dt = new Date(record.time as number)
    if (!Number.isNaN(dt.valueOf())) {
      meta.dt = dt
    }
  }

  for (const key of Object.keys(record)) {
    if (!RESERVED_KEYS.has(key)) {
      meta[key] = record[key]
    }
  }

  // Pino passes the message as `msg`, but a user-supplied object may carry
  // `message` instead. Prefer `msg`; preserve a conflicting `message`.
  const msg = (record.msg ?? record.message ?? '') as string
  if (record.msg !== undefined && record.message !== undefined) {
    meta.message_field = record.message
  }

  const level: ILogLevel = toLogtailLevel(record.level as number)
  logtail.log(msg, level, meta).catch(ignoreRejection)
}

/**
 * An in-process BetterStack/Logtail destination for `pino.multistream`.
 *
 * `@logtail/pino` is a `pino-abstract-transport`, which pino runs on a worker
 * thread via `thread-stream`. Worker threads load their entry files by path at
 * runtime, which breaks under `bun build --compile` (no node_modules on disk).
 * This stream does the same work in-process: it receives the serialized
 * newline-delimited JSON that pino writes, and forwards each record to the
 * `@logtail/node` client — no worker, so it survives compilation.
 */
export const createLogtailStream = (token: string, endpoint?: string): Writable => {
  const options: Partial<ILogtailNodeOptions> = {}
  if (endpoint) {
    options.endpoint = endpoint
  }
  const logtail = new Logtail(token, options)

  // Best-effort flush when the event loop drains (covers short-lived workers).
  // We deliberately do not register SIGINT/SIGTERM handlers: adding a signal
  // listener suppresses Node's default termination, which would hang services
  // that have no shutdown handler of their own.
  process.once('beforeExit', () => {
    logtail.flush().catch(ignoreRejection)
  })

  return new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const line of text.split('\n')) {
        if (line.length === 0) {
          continue
        }
        try {
          forward(logtail, JSON.parse(line) as Record<string, unknown>)
        } catch {
          // A malformed line must never break the logging pipeline.
        }
      }
      callback()
    },
  })
}
