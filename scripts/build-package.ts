// Builds the langmail-mcp npm package: one Node-compatible ESM bundle of the
// self-hosted server (src/self-hosted.ts) in dist/, run by the package's
// `langmail-mcp` bin under Node or Bun. `npm pack` runs this through the
// `prepack` script. The hosted server does not use it: it runs from source
// under Bun in its container image.
//
// Two modules are swapped in the bundle (packageModules below):
// - email-render/viewer-build.ts: the email viewer is bundled here, once, and
//   the bundle carries the finished HTML, so the server needs no Bun.build.
// - runs-from-source.ts: says false, so the logger writes no file under the
//   repository's logs/ directory, which an npm install does not have.
//
// npm dependencies stay external: npm installs them from package.json.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { type BunPlugin } from 'bun'

import { buildViewerHtml } from '../src/email-render/viewer-build.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
export const PACKAGE_DIST = path.join(ROOT, 'dist')
const ENTRY = path.join(ROOT, 'src/self-hosted.ts')
const BIN_NAME = 'langmail-mcp.js'

const VIEWER_BUILD_RE = /[/\\]src[/\\]email-render[/\\]viewer-build\.ts$/u
const RUNS_FROM_SOURCE_RE = /[/\\]src[/\\]runs-from-source\.ts$/u
// What a Node bundle must not contain: a call into Bun's runtime, or a
// workspace package npm cannot install.
const BUN_API_RE = /\bBun\.[a-zA-Z]/u
const WORKSPACE_IMPORT_RE = /from\s*["']@langmail\//u

export const packageModules = async (): Promise<BunPlugin> => {
  const html = await buildViewerHtml()
  return {
    name: 'langmail-mcp-package-modules',
    setup: (build) => {
      build.onLoad({ filter: VIEWER_BUILD_RE }, () => ({
        contents: `export const buildViewerHtml = () => Promise.resolve(${JSON.stringify(html)})\n`,
        loader: 'ts',
      }))
      build.onLoad({ filter: RUNS_FROM_SOURCE_RE }, () => ({
        contents: 'export const runsFromSource = false\n',
        loader: 'ts',
      }))
    },
  }
}

// Bundles entrypoints for Node into outdir, with the package's module swaps.
// Also used by scripts/test-node.ts for the self-hosted tests.
export const bundleForNode = async (opts: {
  banner?: string
  entrypoints: string[]
  // The entry file's name, e.g. "langmail-mcp.[ext]"; Bun's default otherwise.
  entryNaming?: string
  outdir: string
  root?: string
}): Promise<string[]> => {
  const result = await Bun.build({
    ...(opts.banner ? { banner: opts.banner } : {}),
    // Left to be read at runtime: Bun would otherwise inline "development",
    // and production logging follows the operator's NODE_ENV.
    define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
    entrypoints: opts.entrypoints,
    format: 'esm',
    ...(opts.entryNaming ? { naming: { entry: opts.entryNaming } } : {}),
    outdir: opts.outdir,
    packages: 'external',
    plugins: [await packageModules()],
    ...(opts.root ? { root: opts.root } : {}),
    // Each dynamic import stays its own chunk, loaded when it runs: the
    // entrypoint points the logger at stderr before importing the server.
    splitting: true,
    target: 'node',
  })
  if (!result.success) {
    throw new Error(`bundle failed: ${result.logs.map((l) => l.message).join('; ')}`)
  }
  const problems: string[] = []
  for (const output of result.outputs) {
    const text = await output.text()
    if (BUN_API_RE.test(text)) {
      problems.push(`${output.path} calls a Bun API: ${BUN_API_RE.exec(text)?.[0]}`)
    }
    if (WORKSPACE_IMPORT_RE.test(text)) {
      problems.push(`${output.path} imports a workspace package`)
    }
  }
  if (problems.length > 0) {
    throw new Error(`the Node bundle is not runnable without Bun:\n${problems.join('\n')}`)
  }
  return result.outputs.map((o) => o.path)
}

if (import.meta.main) {
  await rm(PACKAGE_DIST, { force: true, recursive: true })
  const outputs = await bundleForNode({
    banner: '#!/usr/bin/env node',
    entryNaming: 'langmail-mcp.[ext]',
    entrypoints: [ENTRY],
    outdir: PACKAGE_DIST,
  })
  // stderr: npm pack --json, which runs this as prepack, prints JSON on stdout.
  process.stderr.write(
    `built ${path.relative(ROOT, path.join(PACKAGE_DIST, BIN_NAME))} and ${outputs.length - 1} chunk(s)\n`
  )
}
