// The ui://langmail/email-viewer template: a single self-contained HTML
// document, pre-declared as an MCP resource so hosts can prefetch, cache,
// and security-review it before any tool runs (SEP-1865). Per-email data
// never appears here — it arrives through the tool result at call time.
//
// The view's TypeScript (viewer/email-viewer.ts + the ext-apps App SDK) is
// bundled by viewer-build.ts and memoized for the process lifetime. Run from
// source under Bun (the hosted container, dev, tests), that happens at first
// use; the langmail-mcp package swaps viewer-build.ts for the HTML it built
// when the package was built (scripts/build-package.ts), so Node needs no
// bundler.

import { type McpUiResourceMeta } from '@modelcontextprotocol/ext-apps'
import { RESOURCE_MIME_TYPE, registerAppResource } from '@modelcontextprotocol/ext-apps/server'
import { type McpServer } from '@modelcontextprotocol/server'

import { EMAIL_VIEWER_RESOURCE_URI } from './meta.ts'
import { buildViewerHtml } from './viewer-build.ts'

// Memoize the promise, not the string, so concurrent first readers share one
// build instead of racing their own.
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
