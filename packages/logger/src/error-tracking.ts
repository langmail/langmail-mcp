import { contextLinesIntegration, init, nodeContextIntegration, pinoIntegration, setTag } from '@sentry/node'

/**
 * Initialise error tracking for a backend service.
 *
 * Better Stack Error Tracking is Sentry-SDK compatible, so we keep the
 * `@sentry/node` SDK and only point its DSN at Better Stack. The DSN
 * (`BETTERSTACK_ERRORS_DSN`, shaped `https://<token>@<ingesting_host>/<id>`) is
 * provisioned per service by `infra/tofu/betterstack.tf`. Enabled in production
 * only; a missing DSN degrades to a disabled, no-op client.
 */
export function initErrorTracking(serviceName: string): void {
  const dsn = process.env.BETTERSTACK_ERRORS_DSN
  const environment = process.env.NODE_ENV

  init({
    dsn: dsn || '',
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false },
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
