import { contextLinesIntegration, init, nodeContextIntegration, pinoIntegration, setTag } from '@sentry/node'

export function initSentry(serviceName: string): void {
  const dsn = process.env.SENTRY_DSN
  const environment = process.env.NODE_ENV

  init({
    dsn: dsn || '',
    sendDefaultPii: false,
    environment: environment || 'development',
    enabled: environment === 'production',
    integrations: [
      nodeContextIntegration(),
      contextLinesIntegration(),
      pinoIntegration({
        error: { levels: ['error'] },
      }),
    ],
  })

  setTag('service', serviceName)
}

export type { Scope } from '@sentry/node'
// biome-ignore lint/performance/noBarrelFile: re-export needed for package consumers
export { withScope } from '@sentry/node'
