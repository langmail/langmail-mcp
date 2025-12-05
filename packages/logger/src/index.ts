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
} else if (process.env.NODE_ENV === 'production') {
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
  logger = pino(transport)
} else {
  logger = pino({
    level: process.env.LOG_LEVEL || 'info',
  })
}

export { logger }
export default logger
