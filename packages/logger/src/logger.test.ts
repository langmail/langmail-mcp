import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

// NOTE: this import has a side effect. logger.ts opens (and truncates) the dev
// log file for the AMBIENT service name as it loads, so running this suite
// rewrites `logs/${SERVICE_NAME || 'unknown'}.log`. That is why the in-process
// block at the bottom only asserts the export contract and never the ambient
// level: everything env-dependent is covered by subprocesses instead.
import { logger } from './logger'

// logger.ts does all of its work at import time: it reads process.env, picks a
// stream set, and touches the /logs directory as a side effect of being loaded.
// None of that can be re-run in-process — Bun caches the module after the first
// import, so a second import with different env is a no-op. Every env-dependent
// case therefore boots a fresh `bun -e` subprocess with a controlled
// environment and asserts on what that process wrote, the same black-box shape
// as scripts/run-compile-smoke.ts (minus the compile step, which keeps these
// fast).

const LOGGER_MODULE = path.resolve(import.meta.dir, 'logger.ts')

// Duplicates the relative depth in logger.ts (`../../../logs` from src/) —
// keep the two in sync if that path ever changes.
const LOGS_DIR = path.resolve(import.meta.dir, '../../../logs')

interface RunResult {
  exitCode: number
  stderr: string
  stdout: string
}

interface RunOptions {
  logLevel?: string
  nodeEnv?: string
  serviceName?: string
  token?: string
  tokenEndpoint?: string
}

// Emits one record per level so callers can assert on level filtering.
const SCRIPT = `
import { logger } from ${JSON.stringify(LOGGER_MODULE)}
logger.info('probe:info')
logger.warn('probe:warn')
process.exit(0)
`

const run = (options: RunOptions): RunResult => {
  const result = Bun.spawnSync({
    cmd: ['bun', '-e', SCRIPT],
    // Empty strings rather than deletions: logger.ts treats every one of these
    // as falsy-means-absent, and this way an inherited value from the outer
    // test run can never leak in and flip a branch.
    env: {
      ...process.env,
      NODE_ENV: options.nodeEnv ?? '',
      SERVICE_NAME: options.serviceName ?? '',
      LOG_LEVEL: options.logLevel ?? '',
      BETTERSTACK_SOURCE_TOKEN: options.token ?? '',
      BETTERSTACK_ENDPOINT: options.tokenEndpoint ?? '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  // A subprocess that dies at import writes nothing, which would otherwise let
  // the emptiness-tolerant assertions below pass green. Fail loudly instead.
  if (result.exitCode !== 0) {
    throw new Error(`logger subprocess exited ${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  return { exitCode: result.exitCode, stderr, stdout }
}

const parseRecords = (stdout: string): Record<string, unknown>[] =>
  stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

// One service name per scenario so the files below don't clobber each other or
// a developer's real service logs. They are fixed constants, so this assumes a
// single test run at a time against a given checkout. /logs is gitignored
// scratch space.
const DEV_SERVICE = 'logger-test-dev'
const TRUNCATE_SERVICE = 'logger-test-truncate'
const LEVEL_SERVICE = 'logger-test-level'
const PROD_SERVICE = 'logger-test-prod'

// A plain FILE at the path logger.ts wants to use as a DIRECTORY. This is the
// cheapest way to make its mkdirSync fail for real, which is the only way to
// reach the stdout-only fallback without an unwritable filesystem.
const BLOCKED_SERVICE = 'logger-test-blocked'
const BLOCKED_PARENT = path.join(LOGS_DIR, `${BLOCKED_SERVICE}.log`)
const BLOCKED_NESTED_SERVICE = `${BLOCKED_SERVICE}.log/nested`

const logFileFor = (serviceName: string): string => path.join(LOGS_DIR, `${serviceName}.log`)

// Swept both before and after. afterAll does not run when a run is interrupted
// (SIGINT, OOM, a CI step timeout), and a leftover logger-test-prod.log would
// make the "does not touch /logs" assertion fail on the next run until someone
// hand-deleted a gitignored file.
const sweepFixtures = (): void => {
  for (const service of [DEV_SERVICE, TRUNCATE_SERVICE, LEVEL_SERVICE, PROD_SERVICE]) {
    fs.rmSync(logFileFor(service), { force: true })
  }
  fs.rmSync(BLOCKED_PARENT, { force: true, recursive: true })
}

beforeAll(() => {
  fs.mkdirSync(LOGS_DIR, { recursive: true })
  sweepFixtures()
  fs.writeFileSync(BLOCKED_PARENT, '', { flag: 'w' })
})

afterAll(sweepFixtures)

describe('logger', () => {
  test('writes newline-delimited JSON records to stdout', () => {
    const result = run({ serviceName: DEV_SERVICE })

    expect(result.exitCode).toBe(0)
    const records = parseRecords(result.stdout)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ level: 30, msg: 'probe:info' })
    expect(records[1]).toMatchObject({ level: 40, msg: 'probe:warn' })
  })

  test('stamps every record with SERVICE_NAME as the base `service` field', () => {
    const records = parseRecords(run({ serviceName: DEV_SERVICE }).stdout)

    expect(records).toHaveLength(2)
    expect(records.every((record) => record.service === DEV_SERVICE)).toBe(true)
  })

  // `process.env.SERVICE_NAME || 'unknown'` — note `||`, not `??`, so an empty
  // SERVICE_NAME is treated as unset rather than producing a blank service tag.
  test('falls back to the service name "unknown" when SERVICE_NAME is empty', () => {
    const records = parseRecords(run({ serviceName: '' }).stdout)

    expect(records[0]).toMatchObject({ service: 'unknown' })
  })

  test('also writes records to /logs/<service>.log outside production', () => {
    run({ serviceName: DEV_SERVICE })

    const contents = fs.readFileSync(logFileFor(DEV_SERVICE), 'utf8')
    expect(contents).toContain('probe:info')
    expect(contents).toContain('probe:warn')
    expect(parseRecords(contents)[0]).toMatchObject({ service: DEV_SERVICE })
  })

  // The dev log file is opened with `flag: 'w'`, so each boot starts a fresh
  // file rather than appending across restarts.
  test('truncates an existing dev log file on import', () => {
    fs.writeFileSync(logFileFor(TRUNCATE_SERVICE), 'stale-line-from-a-previous-run\n')

    run({ serviceName: TRUNCATE_SERVICE })

    const contents = fs.readFileSync(logFileFor(TRUNCATE_SERVICE), 'utf8')
    expect(contents).not.toContain('stale-line-from-a-previous-run')
    expect(contents).toContain('probe:info')
  })

  test('applies LOG_LEVEL to every stream', () => {
    const result = run({ logLevel: 'warn', serviceName: LEVEL_SERVICE })

    const records = parseRecords(result.stdout)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ msg: 'probe:warn' })

    // The level gates the file destination too, not just stdout.
    const contents = fs.readFileSync(logFileFor(LEVEL_SERVICE), 'utf8')
    expect(contents).not.toContain('probe:info')
    expect(contents).toContain('probe:warn')
  })

  // resolveLevel owns the fallback; this asserts logger.ts actually routes
  // LOG_LEVEL through it instead of handing the raw value to pino, where an
  // unknown level would silently drop every record.
  test('falls back to info when LOG_LEVEL is unknown', () => {
    const result = run({ logLevel: 'verbose', serviceName: DEV_SERVICE })

    expect(result.stderr).toContain('unknown LOG_LEVEL "verbose"')
    expect(parseRecords(result.stdout)).toHaveLength(2)
  })

  describe('in production', () => {
    test('logs to stdout and does not touch /logs', () => {
      const result = run({ nodeEnv: 'production', serviceName: PROD_SERVICE })

      expect(result.exitCode).toBe(0)
      expect(parseRecords(result.stdout)).toHaveLength(2)
      expect(fs.existsSync(logFileFor(PROD_SERVICE))).toBe(false)
    })

    // Scoped deliberately narrowly: this covers only that adding the BetterStack
    // stream to the multistream set leaves stdout delivery intact and the
    // process exiting cleanly. It does NOT exercise a delivery attempt — the
    // probe script calls process.exit(0), which tears the process down before
    // the Logtail client dispatches anything and before its beforeExit flush
    // runs (verified: a loopback sink receives zero connections). Testing the
    // failure-swallowing path for real means letting the process drain, which
    // costs ~7s of retry backoff. The endpoint is still pinned to a closed
    // loopback port so that no future change to this test can reach a real
    // network from CI.
    test('adding the BetterStack stream leaves stdout logging intact', () => {
      const result = run({
        nodeEnv: 'production',
        serviceName: PROD_SERVICE,
        token: 'test-token-not-a-real-credential',
        tokenEndpoint: 'http://127.0.0.1:9',
      })

      expect(result.exitCode).toBe(0)
      expect(parseRecords(result.stdout)).toHaveLength(2)
    })
  })

  // The guard that keeps a compiled binary on a read-only filesystem from
  // crashing on import.
  test('degrades to stdout-only with a stderr notice when /logs is unavailable', () => {
    const result = run({ serviceName: BLOCKED_NESTED_SERVICE })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('/logs unavailable, falling back to stdout-only')
    expect(parseRecords(result.stdout)).toHaveLength(2)
  })

  // The subprocess cases above are the only way to vary the environment, but
  // they run outside the coverage instrumentation. This block imports the
  // module directly so the export contract every service depends on is pinned
  // in-process: one ready-to-use pino logger, not a factory.
  describe('the exported instance', () => {
    test('is a configured pino logger', () => {
      expect(typeof logger.info).toBe('function')
      expect(typeof logger.warn).toBe('function')
      expect(typeof logger.error).toBe('function')
      expect(typeof logger.child).toBe('function')
    })

    test('carries the service name as a base binding on every record', () => {
      expect(logger.bindings()).toHaveProperty('service')
    })

    // Deliberately not asserting 'info' here: this instance picks up the
    // ambient LOG_LEVEL, so pinning the exact value would fail under
    // `LOG_LEVEL=debug bun test`. The default, and the fallback for a bogus
    // value, are pinned by the subprocess cases above, which control the env.
    // What matters in-process is that pino never receives a level it would
    // silently treat as "drop everything".
    test('is always configured with a level pino recognizes', () => {
      expect(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).toContain(logger.level)
    })
  })
})
