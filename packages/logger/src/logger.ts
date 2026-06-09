import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'

import { createLogtailStream } from './logtail-stream'

// Server only - safe to access process.env
const serviceName = process.env.SERVICE_NAME || 'unknown'
const base = { service: serviceName }
const level = (process.env.LOG_LEVEL || 'info') as pino.Level

// We use pino.multistream()/pino.destination() rather than pino.transport().
// transport() runs each target on a worker thread (thread-stream), which loads
// its entry files by path at runtime — that breaks under `bun build --compile`
// (no node_modules on disk). multistream/destination run in-process, so the
// same logger works for both interpreted and single-binary consumers.
//
// Destinations are async (sonic-boom's default, sync: false) so logging never
// blocks the event loop on a write syscall — matching the non-blocking property
// of the previous worker-thread transport.

const streams: pino.StreamEntry[] = [
  // stdout — captured by journald (prod) or piped to pino-pretty (dev).
  { level, stream: pino.destination({ dest: 1 }) },
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
    streams.push({ level, stream: pino.destination({ dest: logFilePath }) })
  } catch (error) {
    process.stderr.write(`@langmail/logger: /logs unavailable, falling back to stdout-only (${String(error)})\n`)
  }
}

const multi = pino.multistream(streams)

// Async destinations don't block the event loop during normal operation, but a
// short-lived process that logs and exits would lose buffered lines. flushSync
// on exit drains every sonic-boom destination synchronously (it skips streams
// without flushSync, e.g. the Logtail stream, which flushes on beforeExit).
process.on('exit', () => {
  multi.flushSync()
})

const logger: pino.Logger<never, boolean> = pino({ base, level }, multi)

export { logger }
