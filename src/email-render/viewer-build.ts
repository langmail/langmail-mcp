// Bundles the email viewer (viewer/email-viewer.ts + the ext-apps App SDK)
// into one self-contained HTML document with Bun.build.
//
// Run from source under Bun, viewer-resource.ts calls this at first use. The
// langmail-mcp package build (scripts/build-package.ts) calls it once and
// replaces this module in the bundle with one that returns the result, so the
// package needs no Bun API at runtime.

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

export const buildViewerHtml = async (): Promise<string> => {
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
