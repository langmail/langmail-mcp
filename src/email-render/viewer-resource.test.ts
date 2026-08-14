import { describe, expect, mock, test } from 'bun:test'

import { emailViewerHtml, registerEmailViewerResource } from './viewer-resource.ts'

const PUBLIC = 'https://mcp.example.org'

describe('emailViewerHtml', () => {
  test('bundles the view into one self-contained HTML document', async () => {
    const html = await emailViewerHtml()
    expect(html).toStartWith('<!doctype html>')
    // The App SDK handshake code must be inlined — no external scripts.
    expect(html).toContain('<script>')
    expect(html).not.toContain('<script src=')
    expect(html).toContain('me.langmail/email-preview')
    // A "</script>" inside a JS string literal must not terminate the tag:
    // the only closer allowed is the shell's own, so the inlined JS between
    // the opening tag and the final closer must contain none.
    const js = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'))
    expect(js).not.toContain('</script>')
  })

  test('is memoized', async () => {
    expect(await emailViewerHtml()).toBe(await emailViewerHtml())
  })
})

describe('registerEmailViewerResource', () => {
  test('registers ui://langmail/email-viewer with the MCP Apps mime type and a CSP scoped to our origin', async () => {
    const registerResource = mock(() => ({}))
    const server = { registerResource } as unknown as Parameters<typeof registerEmailViewerResource>[0]
    registerEmailViewerResource(server, `${PUBLIC}/`)

    expect(registerResource).toHaveBeenCalledTimes(1)
    const call = registerResource.mock.calls[0] as unknown as [
      string,
      string,
      { _meta?: { ui?: { csp?: { resourceDomains?: string[] } } }; mimeType?: string },
      (uri: URL) => Promise<{ contents: { mimeType?: string; text?: string; uri: string }[] }>,
    ]
    expect(call[1]).toBe('ui://langmail/email-viewer')
    expect(call[2].mimeType).toBe('text/html;profile=mcp-app')
    // Images (cid capability URLs + proxied remote images) load from our
    // origin only — trailing slash normalized away.
    expect(call[2]._meta?.ui?.csp?.resourceDomains).toEqual([PUBLIC])

    const read = await call[3](new URL('ui://langmail/email-viewer'))
    expect(read.contents[0]?.uri).toBe('ui://langmail/email-viewer')
    expect(read.contents[0]?.mimeType).toBe('text/html;profile=mcp-app')
    expect(read.contents[0]?.text).toContain('<script>')
  })
})
