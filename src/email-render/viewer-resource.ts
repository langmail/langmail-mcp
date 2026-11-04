// The ui://langmail/email-viewer template: a single self-contained HTML
// document, pre-declared as an MCP resource so hosts can prefetch, cache,
// and security-review it before any tool runs (SEP-1865). Per-email data
// never appears here — it arrives through the tool result at call time.
//
// The view's TypeScript (viewer/email-viewer.ts + the ext-apps App SDK) is
// bundled at first use with Bun.build and memoized for the process
// lifetime. The service runs from source on Bun everywhere (dev, tests,
// container), so a build-time artifact would only add drift.

import { type McpUiResourceMeta } from '@modelcontextprotocol/ext-apps'
import { RESOURCE_MIME_TYPE, registerAppResource } from '@modelcontextprotocol/ext-apps/server'
import { type McpServer } from '@modelcontextprotocol/server'

import { EMAIL_VIEWER_RESOURCE_URI } from './meta.ts'

const VIEW_ENTRYPOINT = new URL('./viewer/email-viewer.ts', import.meta.url).pathname

// Minimal shell the bundled view script fills in. Theme-neutral colors that
// hold up on light and dark hosts; the email itself renders on white inside
// the nested iframe, matching how mail clients present HTML mail.
const shell = (script: string): string =>
  `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  #header { padding: 12px 16px 10px; border-bottom: 1px solid rgba(128,128,128,.35); }
  #subject { font-weight: 600; font-size: 15px; margin-bottom: 2px; }
  #from, #date { font-size: 12.5px; opacity: .75; }
  #frame { display: block; width: 100%; border: 0; background: #fff; }
</style>
</head>
<body>
<div id="header"><div id="subject"></div><div id="from"></div><div id="date"></div></div>
<iframe id="frame" sandbox="allow-same-origin" referrerpolicy="no-referrer" title="Email"></iframe>
<script type="module">${script}</script>
</body>
</html>
`

const buildViewerHtml = async (): Promise<string> => {
  // esm, not iife: Bun's iife output references its CommonJS-interop helper
  // `__require` without defining it (a bundled require shim deep in the MCP
  // SDK chain triggers it), which threw a ReferenceError inside the host's
  // sandbox and left the view blank. The esm build has no such helper; the
  // shell inlines it as <script type="module">.
  const build = await Bun.build({
    entrypoints: [VIEW_ENTRYPOINT],
    format: 'esm',
    minify: true,
    target: 'browser',
  })
  const output = build.outputs[0]
  if (!(build.success && output)) {
    throw new Error(`email-viewer bundle failed: ${build.logs.map((l) => l.message).join('; ')}`)
  }
  const js = await output.text()
  // "</script>" inside a JS string literal would terminate the inline tag.
  return shell(js.replaceAll('</script>', '<\\/script>'))
}

// Memoize the promise, not the string, so concurrent first readers share one
// Bun.build instead of racing their own.
let cached: Promise<string> | null = null

export const emailViewerHtml = (): Promise<string> => {
  cached ??= buildViewerHtml().catch((err) => {
    // A failed build must not poison every later read.
    cached = null
    throw err
  })
  return cached
}

export const registerEmailViewerResource = (server: McpServer, publicUrl: string): void => {
  // CSP wants origins; MCP_PUBLIC_URL may carry a trailing slash or path.
  const origin = new URL(publicUrl).origin
  // Annotated because ui is hoisted into a const to serve both sites below:
  // excess-property checking only reaches fresh literals, so without the
  // SDK's own shape a misspelled key would travel straight to the host.
  const ui: McpUiResourceMeta = {
    // Images — cid capability URLs and proxied remote images — load from
    // this server only. No connectDomains: the view makes no fetches.
    csp: { resourceDomains: [origin] },
    prefersBorder: true,
  }
  registerAppResource(
    server,
    'email-viewer',
    EMAIL_VIEWER_RESOURCE_URI,
    {
      _meta: { ui },
      description: 'Inline full-fidelity rendering of one email, fed by the preview_email tool.',
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          _meta: { ui },
          mimeType: RESOURCE_MIME_TYPE,
          text: await emailViewerHtml(),
          uri: EMAIL_VIEWER_RESOURCE_URI,
        },
      ],
    })
  )
}
