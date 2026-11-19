import { describe, expect, test } from 'bun:test'

import { type EmailSetChanges } from '../jmap/index.ts'
import { type ApplyIo, buildChanges, makeMailRulesApplier, ruleFilter, skippedActionTypes } from './apply.ts'
import { type MailRule } from './rule.ts'

const rule = (overrides: Partial<MailRule> = {}): MailRule => ({
  actions: [{ type: 'archive' }, { tag: 'GitHub', type: 'addTag' }, { type: 'markRead' }],
  conditions: { from: 'notifications@github.com' },
  enabled: true,
  id: 'rule-1a2b3c4d',
  match: 'all',
  name: 'Archive GitHub Notifications',
  ...overrides,
})

const MAILBOXES: Record<string, string> = { Archive: 'mb-archive', Inbox: 'mb-inbox', Trash: 'mb-trash' }

const fakeIo = (
  matches: string[],
  overrides: Partial<ApplyIo> = {}
): ApplyIo & { updates: { changes: EmailSetChanges; ids: string[] }[] } => {
  const io = {
    countConversations: () => Promise.resolve(Math.ceil(matches.length / 2)),
    expandToThreads: (_t: string, ids: string[]) => Promise.resolve([...ids, ...ids.map((i) => `${i}-sibling`)]),
    queryEmailIds: () => Promise.resolve(matches),
    resolveMailboxByName: (_t: string, name: string) => Promise.resolve(MAILBOXES[name] ?? `mb-${name.toLowerCase()}`),
    resolveMailboxByRole: (_t: string, role: string, createName: string) =>
      Promise.resolve(MAILBOXES[createName] ?? `mb-${role}`),
    updates: [] as { changes: EmailSetChanges; ids: string[] }[],
    updateEmails: (_t: string, ids: string[], changes: EmailSetChanges) => {
      io.updates.push({ changes, ids })
      return Promise.resolve({ notUpdated: [], updated: ids })
    },
    ...overrides,
  }
  return io as ApplyIo & { updates: { changes: EmailSetChanges; ids: string[] }[] }
}

describe('ruleFilter', () => {
  test('single condition stays flat; inbox scope wraps with AND', () => {
    expect(ruleFilter(rule(), null)).toEqual({ from: 'notifications@github.com' })
    expect(ruleFilter(rule(), 'mb-inbox')).toEqual({
      conditions: [{ inMailbox: 'mb-inbox' }, { from: 'notifications@github.com' }],
      operator: 'AND',
    })
  })

  test('match any/all pick OR/AND over the condition set', () => {
    const conditions = {
      bodyContains: 'invoice',
      from: 'stripe.com',
      hasAttachment: true,
      subject: 'invoice',
      to: 'me@x',
    }
    const all = ruleFilter(rule({ conditions }), null)
    const any = ruleFilter(rule({ conditions, match: 'any' }), null)
    expect(all).toEqual({
      conditions: [
        { from: 'stripe.com' },
        { to: 'me@x' },
        { subject: 'invoice' },
        { body: 'invoice' },
        { hasAttachment: true },
      ],
      operator: 'AND',
    })
    expect((any as { operator: string }).operator).toBe('OR')
  })
})

describe('buildChanges', () => {
  const ctx = {
    inboxId: 'mb-inbox',
    resolveByName: (name: string) => Promise.resolve(MAILBOXES[name] ?? `mb-${name.toLowerCase()}`),
    resolveByRole: (role: 'archive' | 'trash') => Promise.resolve(role === 'archive' ? 'mb-archive' : 'mb-trash'),
  }

  test('archive + tag + markRead → archive mailbox added, inbox removed, keywords set', async () => {
    const changes = await buildChanges(rule().actions, ctx)
    expect(changes).toEqual({
      keywords: { '$label:github': true, $seen: true },
      mailboxIds: { 'mb-archive': true, 'mb-inbox': false },
    })
  })

  test('copy adds the target without leaving the inbox; delete files into trash', async () => {
    expect(await buildChanges([{ mailbox: 'Backup', type: 'copy' }], ctx)).toEqual({
      mailboxIds: { 'mb-backup': true },
    })
    expect(await buildChanges([{ type: 'delete' }], ctx)).toEqual({
      mailboxIds: { 'mb-inbox': false, 'mb-trash': true },
    })
  })

  test('markUnread and removeTag clear keywords; flag sets $flagged', async () => {
    expect(
      await buildChanges([{ type: 'markUnread' }, { tag: 'Old', type: 'removeTag' }, { type: 'flag' }], ctx)
    ).toEqual({ keywords: { $flagged: true, '$label:old': false, $seen: false } })
  })

  test('forward and stopProcessing contribute nothing and are reported as skipped', async () => {
    const actions: MailRule['actions'] = [{ to: 'x@y.example', type: 'forward' }, { type: 'stopProcessing' }]
    expect(await buildChanges(actions, ctx)).toEqual({})
    expect(skippedActionTypes(actions)).toEqual(['forward', 'stopProcessing'])
  })
})

describe('makeMailRulesApplier', () => {
  test('estimate returns message and conversation counts with the capped flag off for small sets', async () => {
    const io = fakeIo(['m1', 'm2', 'm3'])
    const est = await makeMailRulesApplier(io).estimate('tok', rule(), 'inbox')
    expect(est).toEqual({ capped: false, conversations: 2, messages: 3 })
  })

  test('applyToExisting patches every match and reports counts', async () => {
    const io = fakeIo(['m1', 'm2'])
    const res = await makeMailRulesApplier(io).applyToExisting('tok', rule(), 'messages', 'inbox')
    expect(res).toEqual({ failed: 0, matched: 2, modified: 2, skippedActions: [] })
    expect(io.updates[0]?.ids).toEqual(['m1', 'm2'])
    expect(io.updates[0]?.changes.mailboxIds).toEqual({ 'mb-archive': true, 'mb-inbox': false })
  })

  test('conversations mode expands matches to whole threads before patching', async () => {
    const io = fakeIo(['m1'])
    const res = await makeMailRulesApplier(io).applyToExisting('tok', rule(), 'conversations', 'all')
    expect(res.matched).toBe(2)
    expect(io.updates[0]?.ids).toEqual(['m1', 'm1-sibling'])
  })

  test('a forward-only rule modifies nothing but reports the skip', async () => {
    const io = fakeIo(['m1'])
    const res = await makeMailRulesApplier(io).applyToExisting(
      'tok',
      rule({ actions: [{ to: 'oncall@example.com', type: 'forward' }] }),
      'messages',
      'all'
    )
    expect(res).toEqual({ failed: 0, matched: 1, modified: 0, skippedActions: ['forward'] })
    expect(io.updates).toHaveLength(0)
  })

  test('partial Email/set failures surface as failed count', async () => {
    const io = fakeIo(['m1', 'm2'], {
      updateEmails: (_t, ids) =>
        Promise.resolve({ notUpdated: [{ id: ids[1] ?? '', type: 'notFound' }], updated: [ids[0] ?? ''] }),
    })
    const res = await makeMailRulesApplier(io).applyToExisting('tok', rule(), 'messages', 'all')
    expect(res.modified).toBe(1)
    expect(res.failed).toBe(1)
  })
})
