import fs from 'node:fs'
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
  // All services write to a single log file for easy agent consumption
  const logFilePath = path.resolve(import.meta.dirname, '../../../logs/dev.log')
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
  fs.writeFileSync(logFilePath, '', { flag: 'w' })

  const transport = pino.transport({
    targets: [
      { target: 'pino/file', options: { destination: 1 } },
      { target: 'pino/file', options: { destination: logFilePath, append: true } },
    ],
  })

  logger = pino({ base, level: process.env.LOG_LEVEL || 'info' }, transport)
}

export { logger }
