import * as Sentry from '@sentry/node'

export function initSentry(serviceName: string): void {
  const dsn = process.env.SENTRY_DSN
  const environment = process.env.NODE_ENV

  Sentry.init({
    dsn: dsn || '',
    sendDefaultPii: true,
    environment: environment || 'development',
    enabled: environment === 'production',
    integrations: [
      Sentry.nodeContextIntegration(),
      Sentry.contextLinesIntegration(),
      Sentry.pinoIntegration({
        error: { levels: ['error'] },
      }),
    ],
  })

  Sentry.setTag('service', serviceName)
}

export { Sentry }
export type { Scope } from '@sentry/node'
