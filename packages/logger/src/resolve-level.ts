import type pino from 'pino'

const levels: ReadonlySet<string> = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])

/**
 * Normalize a LOG_LEVEL env value to a valid pino level. Pino level strings
 * are case-sensitive and an unknown level in a multistream entry doesn't
 * throw — it silently drops every record on that stream. Lowercase the input
 * and fall back to 'info' (with a stderr warning) so a value like "INFO" can
 * never disable logging. 'silent' is deliberately rejected for the same
 * reason: this env var must not be able to turn logging off.
 */
export const resolveLevel = (raw: string | undefined): pino.Level => {
  if (!raw) {
    return 'info'
  }
  const level = raw.trim().toLowerCase()
  if (!level) {
    return 'info'
  }
  if (levels.has(level)) {
    return level as pino.Level
  }
  process.stderr.write(`@langmail/logger: unknown LOG_LEVEL "${raw}", falling back to "info"\n`)
  return 'info'
}
