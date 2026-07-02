import { describe, expect, test } from 'bun:test'

import { type EmailGetParams, type EmailRecord } from '@langmail/jmap'

import { getThread, getThreadInput } from './get-thread.ts'

const deps = (opts: { ids?: string[]; emails?: EmailRecord[]; onGet?: (p: EmailGetParams) => void }) => ({
  emailGet: (p: EmailGetParams) => {
    opts.onGet?.(p)
    return Promise.resolve(opts.emails ?? [])
  },
  resolveAccountId: () => Promise.resolve('acct'),
  threadEmailIds: () => Promise.resolve(opts.ids ?? []),
})

describe('getThreadInput schema', () => {
  test('requires a non-empty id', () => {
    expect(getThreadInput.safeParse({ id: '' }).success).toBe(false)
    expect(getThreadInput.safeParse({ id: 'e1' }).success).toBe(true)
  })
})

describe('getThread', () => {
  test('lists the thread oldest-first and marks the requested message', async () => {
    let getIds: string[] | undefined
    const result = await getThread(
      deps({
        // emailGet returns them out of order; the tool restores thread order.
        emails: [
          { id: 'e2', receivedAt: '2026-01-02T00:00:00Z', subject: 'Re: Hi' },
          { id: 'e1', receivedAt: '2026-01-01T00:00:00Z', subject: 'Hi' },
        ],
        ids: ['e1', 'e2'],
        onGet: (p) => (getIds = p.ids),
      }),
      { args: { id: 'e2' }, token: 'tok' }
    )
    // The resolved thread ids are hydrated via emailGet.
    expect(getIds).toEqual(['e1', 'e2'])
    const txt = result.content[0]?.text ?? ''
    expect(txt).toContain('2 message(s) in thread')
    // e1 (oldest) is listed first, e2 second and marked as requested.
    expect(txt.indexOf('1. Hi')).toBeLessThan(txt.indexOf('2. Re: Hi'))
    expect(txt).toContain('2. Re: Hi  ← requested')
    expect(txt).toContain('id: e1')
    expect(txt).toContain('id: e2')
  })

  test('returns an error result when the thread is empty/unknown', async () => {
    const result = await getThread(deps({ ids: [] }), { args: { id: 'nope' }, token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('nope')
  })
})
