import { describe, expect, mock, test } from 'bun:test'

import { emailViewerHtml, registerEmailViewerResource } from './viewer-resource.ts'

const PUBLIC = 'https://mcp.example.org'

// A build that reports success but emits nothing fails with an empty log
// list. Lives up here because the linter keeps regexes out of callbacks.
const NO_LOGS_FAILURE = /^email-viewer bundle failed: $/

describe('emailViewerHtml', () => {
  test('bundles the view into one self-contained HTML document', async () => {
    const html = await emailViewerHtml()
    expect(html).toStartWith('<!doctype html>')
    // The App SDK handshake code must be inlined — no external scripts.
    expect(html).toContain('<script type="module">')
    expect(html).not.toContain('<script src=')
    expect(html).toContain('me.langmail/email-preview')
    const open = '<script type="module">'
    const js = html.slice(html.indexOf(open) + open.length, html.lastIndexOf('</script>'))
    // A "</script>" inside a JS string literal must not terminate the tag:
    // the only closer allowed is the shell's own, so the inlined JS between
    // the opening tag and the final closer must contain none.
    expect(js).not.toContain('</script>')
    // Bun's iife format references its CommonJS-interop helper without ever
    // defining it (the SDK chain contains a bundled `require` shim), which
    // crashed the view on claude.ai with `__require is not defined`. The esm
    // build keeps the dependency's own guarded shim instead. Tripwire only:
    // if a future bundle legitimately *defines* the helper, relax this to
    // check reference-without-definition.
    expect(js).not.toContain('__require')
  })

  test('is memoized', () => {
    // Compared unawaited: two real builds are byte-identical, so comparing
    // the strings passes even with the memo deleted. The promise identity is
    // what the memo actually guarantees.
    expect(emailViewerHtml()).toBe(emailViewerHtml())
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
    expect(read.contents[0]?.text).toContain('<script type="module">')
  })
})

describe('when the bundle fails', () => {
  // The memo lives in module scope and the suite above already filled it with
  // a successful build, so these cases need their own module instance — the
  // query string is what makes Bun hand back a fresh one. All of them share
  // that single instance, and every case but the last leaves the memo empty
  // again, which is exactly the behaviour under test.
  //
  // Typed as a plain string, not a literal: the query string has to survive to
  // Bun (an absolute file:// href is normalized back to the same instance),
  // while TypeScript must not try to resolve it as part of the path.
  const FRESH_SPECIFIER: string = './viewer-resource.ts?failure-cases'
  let fresh: Promise<typeof import('./viewer-resource.ts')> | null = null
  const freshModule = (): Promise<typeof import('./viewer-resource.ts')> => {
    fresh ??= import(FRESH_SPECIFIER) as Promise<typeof import('./viewer-resource.ts')>
    return fresh
  }

  // Swapped by hand rather than with spyOn: restoring a spy over the native
  // Bun.build leaves behind a binding the bundler can no longer read files
  // through, which breaks the real builds in this file and every other one.
  // Only the three fields buildViewerHtml reads are fabricated — revisit the
  // cast if it ever reaches for more of BuildOutput.
  const withStubbedBuild = async (
    result: { logs?: { message: string }[]; outputs?: { text: () => Promise<string> }[]; success: boolean },
    body: () => Promise<void>
  ): Promise<void> => {
    const original = Bun.build
    Bun.build = (() =>
      Promise.resolve({
        logs: result.logs ?? [],
        outputs: result.outputs ?? [],
        success: result.success,
      })) as unknown as typeof Bun.build
    try {
      await body()
    } finally {
      Bun.build = original
    }
  }

  test('rejects with every bundler log message joined', async () => {
    const { emailViewerHtml: viewerHtml } = await freshModule()
    const logs = [{ message: 'no loader for .foo' }, { message: 'unresolved import' }]
    await withStubbedBuild({ logs, success: false }, async () => {
      await expect(viewerHtml()).rejects.toThrow('email-viewer bundle failed: no loader for .foo; unresolved import')
    })
  })

  test('rejects when the build reports success but emits no output', async () => {
    const { emailViewerHtml: viewerHtml } = await freshModule()
    await withStubbedBuild({ success: true }, async () => {
      await expect(viewerHtml()).rejects.toThrow(NO_LOGS_FAILURE)
    })
  })

  test('surfaces the failure through the registered resource read', async () => {
    const { registerEmailViewerResource: register } = await freshModule()
    const registerResource = mock(() => ({}))
    const server = { registerResource } as unknown as Parameters<typeof register>[0]
    register(server, PUBLIC)
    const read = (registerResource.mock.calls[0] as unknown as [string, string, unknown, () => Promise<unknown>])[3]

    await withStubbedBuild({ logs: [{ message: 'boom' }], success: false }, async () => {
      await expect(read()).rejects.toThrow('email-viewer bundle failed: boom')
    })
  })

  test('does not poison the memo — the next read builds again', async () => {
    const { emailViewerHtml: viewerHtml } = await freshModule()
    await withStubbedBuild({ logs: [{ message: 'transient' }], success: false }, async () => {
      await expect(viewerHtml()).rejects.toThrow('email-viewer bundle failed: transient')
    })

    // Recovery is shown against a stubbed success rather than a real build:
    // under bun test a second Bun.build of this entrypoint in one process
    // fails to read its inputs (it is fine under bun run, so the recovery
    // path itself is sound). Had the rejected promise stayed in the memo,
    // this read would reject too. Keep this case last — it is the one that
    // leaves a build in the memo.
    await withStubbedBuild({ outputs: [{ text: () => Promise.resolve('/* rebuilt */') }], success: true }, async () => {
      expect(await viewerHtml()).toContain('/* rebuilt */')
    })
  })
})
