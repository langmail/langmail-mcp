import pino from 'pino'

let logger: pino.Logger<never, boolean>

// Browser environment - use console
if ('window' in globalThis) {
  logger = {
    info: console.log,
    error: console.error,
    warn: console.warn,
    debug: console.debug,
    trace: console.trace,
    fatal: console.error,
    child: () => logger,
  } as any
} else {
  // Server only - safe to access process.env
  const serviceName = process.env.SERVICE_NAME || 'unknown'
  const base = { service: serviceName }

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
    logger = pino({
      base,
      level: process.env.LOG_LEVEL || 'info',
    })
  }
}

const requireEnv = (key: string): string => {
  const value = process.env[key]
  if (!value) {
    logger.error(`${key} environment variable is required`)
    throw new Error(`${key} environment variable is required`)
  }
  return value
}

export { logger, requireEnv }
export default logger
