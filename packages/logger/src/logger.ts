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

let logger: pino.Logger<never, boolean>

if (process.env.NODE_ENV === 'production') {
  const streams: pino.StreamEntry[] = [
    // stdout — captured by journald on the server.
    { level, stream: pino.destination({ dest: 1, sync: true }) },
  ]

  const token = process.env.BETTERSTACK_SOURCE_TOKEN
  if (token) {
    streams.push({ level, stream: createLogtailStream(token, process.env.BETTERSTACK_ENDPOINT) })
  }

  logger = pino({ base, level }, pino.multistream(streams))
} else {
  const streams: pino.StreamEntry[] = [{ level, stream: pino.destination({ dest: 1, sync: true }) }]

  // Bun inlines process.env.NODE_ENV at build time, so a compiled binary built
  // without NODE_ENV=production bakes in this dev branch. Guard the /logs setup
  // so such a binary (read-only fs) degrades to stdout-only instead of crashing
  // on import.
  try {
    const logFilePath = path.resolve(import.meta.dirname, `../../../logs/${serviceName}.log`)
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
    fs.writeFileSync(logFilePath, '', { flag: 'w' })
    streams.push({ level, stream: pino.destination({ dest: logFilePath, sync: true }) })
  } catch {
    // No writable /logs — stdout-only is an acceptable fallback.
  }

  logger = pino({ base, level }, pino.multistream(streams))
}

export { logger }
