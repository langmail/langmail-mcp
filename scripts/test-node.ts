// Runs the self-hosted mode's tests under Node, as CI does
// (.github/workflows/release.yml): `bun run test:node`.
//
// Node cannot run this source as it is (extensionless imports, TypeScript), so
// the test files are bundled the way the langmail-mcp package is
// (scripts/build-package.ts, with its module swaps) into a directory under
// node_modules/.cache, where Node resolves the npm packages they import and
// `bun test` does not look, and run there with `node --test`. `bun test` runs the same files under Bun.

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { bundleForNode } from './build-package.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const TEST_FILES = ['config.test.ts', 'listen.test.ts', 'self-hosted.test.ts'].map((name) =>
  path.join(ROOT, 'src/self-hosted', name)
)

const cache = path.join(ROOT, 'node_modules/.cache')
await mkdir(cache, { recursive: true })
const outdir = await mkdtemp(path.join(cache, 'node-test-'))
try {
  const outputs = await bundleForNode({ entrypoints: TEST_FILES, outdir, root: path.join(ROOT, 'src') })
  const tests = outputs.filter((p) => p.endsWith('.test.js'))
  if (tests.length !== TEST_FILES.length) {
    throw new Error(`expected ${TEST_FILES.length} bundled test files, got ${tests.join(', ')}`)
  }
  const result = spawnSync('node', ['--test', ...tests], {
    env: { ...process.env, LOG_LEVEL: 'warn', MCP_LOG_STDERR: '1' },
    stdio: 'inherit',
  })
  process.exitCode = result.status ?? 1
} finally {
  await rm(outdir, { force: true, recursive: true })
}
