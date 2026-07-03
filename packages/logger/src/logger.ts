import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'

import { createLogtailStream } from './logtail-stream'
import { resolveLevel } from './resolve-level'

// Server only - safe to access process.env
const serviceName = process.env.SERVICE_NAME || 'unknown'
const base = { service: serviceName }
const level = resolveLevel(process.env.LOG_LEVEL)

// We use pino.multistream()/pino.destination() rather than pino.transport().
// transport() runs each target on a worker thread (thread-stream), which loads
// its entry files by path at runtime — that breaks under `bun build --compile`
// (no node_modules on disk). multistream/destination run in-process, so the
// same logger works for both interpreted and single-binary consumers.
//
// File/stdout destinations are synchronous (sync: true). Async (sonic-boom's
// default) is non-blocking but loses buffered/in-flight writes when a short-lived
// process calls process.exit() — flushSync on exit can't reconcile a write
// already dispatched to the OS — which silently drops log lines for scripts and
// for compiled binaries that log at startup. Sync writes complete before the next
// line, so nothing is lost; the cost (a write syscall per log) is negligible at
// this app's logging volume. The Logtail stream remains async (it batches over
// the network and flushes on beforeExit).

const streams: pino.StreamEntry[] = [
  // stdout — captured by journald (prod) or piped to pino-pretty (dev).
  { level, stream: pino.destination({ dest: 1, sync: true }) },
]

if (process.env.NODE_ENV === 'production') {
  const token = process.env.BETTERSTACK_SOURCE_TOKEN
  if (token) {
    streams.push({ level, stream: createLogtailStream(token, process.env.BETTERSTACK_ENDPOINT) })
  }
} else {
  // Bun inlines process.env.NODE_ENV at build time, so a compiled binary built
  // without NODE_ENV=production bakes in this dev branch. Guard the /logs setup
  // so such a binary (read-only fs) degrades to stdout-only instead of crashing
  // on import.
  try {
    const logFilePath = path.resolve(import.meta.dirname, `../../../logs/${serviceName}.log`)
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
    fs.writeFileSync(logFilePath, '', { flag: 'w' })
    streams.push({ level, stream: pino.destination({ dest: logFilePath, sync: true }) })
  } catch (error) {
    process.stderr.write(`@langmail/logger: /logs unavailable, falling back to stdout-only (${String(error)})\n`)
  }
}

const logger: pino.Logger<never, boolean> = pino({ base, level }, pino.multistream(streams))

export { logger }
