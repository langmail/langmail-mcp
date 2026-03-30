import path from 'node:path'
import pino from 'pino'

// Server only - safe to access process.env
const serviceName = process.env.SERVICE_NAME || 'unknown'
const base = { service: serviceName }

let logger: pino.Logger<never, boolean>

if (process.env.NODE_ENV === 'production') {
  const transport = pino.transport({
    targets: [
      {
        target: '@logtail/pino',
        options: {
          sourceToken: process.env.BETTERSTACK_SOURCE_TOKEN,
          options: { endpoint: process.env.BETTERSTACK_ENDPOINT },
        },
      },
      {
        target: 'pino/file',
        options: { destination: 1 },
      },
    ],
  })
  logger = pino({ base }, transport)
} else {
  // Resolve to repo root logs/ dir (packages/logger/src -> ../../../logs)
  const logFilePath = path.resolve(import.meta.dirname, `../../../logs/${serviceName}.log`)

  const transport = pino.transport({
    targets: [
      { target: 'pino/file', options: { destination: 1 } },
      {
        target: 'pino-roll',
        options: {
          file: logFilePath,
          size: '10m',
          limit: { count: 3 },
          mkdir: true,
        },
      },
    ],
  })

  logger = pino({ base, level: process.env.LOG_LEVEL || 'info' }, transport)
}

export { logger }
