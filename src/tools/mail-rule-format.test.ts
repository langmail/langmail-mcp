import { describe, expect, test } from 'bun:test'

import { type MailRule, type MailRuleAction, type MailRuleConditions } from '../rules/rule.ts'
import {
  describeActions,
  describeConditions,
  formatApplyResult,
  formatEstimate,
  formatMailRule,
} from './mail-rule-format.ts'
import { githubRule, NOW } from './mail-rule-test-fixtures.ts'

// A rule whose conditions and name are visible in the assertions below, so the
// fixture's own sender never leaks into an expected string.
const rule = (overrides: Partial<MailRule> = {}): MailRule =>
  githubRule({ conditions: { from: 'billing@example.com' }, name: 'Archive Billing', ...overrides })

describe('describeConditions', () => {
  test('renders each condition in a fixed order, not insertion order', () => {
    const conditions: MailRuleConditions = {
      bodyContains: 'unsubscribe',
      from: 'billing@example.com',
      hasAttachment: true,
      subject: 'Invoice',
      to: 'team@example.org',
    }
    expect(describeConditions(conditions, 'all')).toBe(
      'sender contains "billing@example.com" AND recipient contains "team@example.org" AND ' +
        'subject contains "Invoice" AND body contains "unsubscribe" AND has an attachment'
    )
  })

  test('joins with OR when the rule matches any condition', () => {
    expect(describeConditions({ from: 'billing@example.com', subject: 'Invoice' }, 'any')).toBe(
      'sender contains "billing@example.com" OR subject contains "Invoice"'
    )
  })

  test('treats any match other than "any" as AND', () => {
    expect(describeConditions({ from: 'billing@example.com', subject: 'Invoice' }, 'all')).toBe(
      'sender contains "billing@example.com" AND subject contains "Invoice"'
    )
  })

  test('omits hasAttachment when it is false, since false means "not set"', () => {
    expect(describeConditions({ hasAttachment: false, subject: 'Invoice' }, 'all')).toBe('subject contains "Invoice"')
  })

  test('renders an empty string when no condition is set', () => {
    // The schema rejects a condition-less rule, so this is only reachable via a
    // hand-edited metadata comment — it renders blank rather than throwing.
    expect(describeConditions({}, 'all')).toBe('')
  })

  test('does not escape quotes inside a condition value', () => {
    expect(describeConditions({ subject: 'say "hi"' }, 'all')).toBe('subject contains "say "hi""')
  })
})

describe('describeActions', () => {
  test.each([
    [{ tag: 'Acme Corp', type: 'addTag' }, 'add tag "acme-corp"'],
    [{ type: 'archive' }, 'archive'],
    [{ mailbox: 'Finance', type: 'copy' }, 'copy to "Finance"'],
    [{ type: 'delete' }, 'move to Trash'],
    [{ type: 'flag' }, 'flag'],
    [{ to: 'archive@example.com', type: 'forward' }, 'forward a copy to archive@example.com'],
    [{ type: 'markRead' }, 'mark as read'],
    [{ type: 'markUnread' }, 'mark as unread'],
    [{ mailbox: 'Finance', type: 'move' }, 'move to "Finance"'],
    [{ tag: 'Acme Corp', type: 'removeTag' }, 'remove tag "acme-corp"'],
    [{ type: 'stopProcessing' }, 'stop processing later rules'],
  ] as [MailRuleAction, string][])('describes %o', (action, expected) => {
    expect(describeActions([action])).toBe(expected)
  })

  test('joins several actions with ", then " in the given order', () => {
    expect(
      describeActions([{ type: 'markRead' }, { mailbox: 'Finance', type: 'move' }, { type: 'stopProcessing' }])
    ).toBe('mark as read, then move to "Finance", then stop processing later rules')
  })

  test('falls back to the raw tag when it slugifies to nothing', () => {
    // The schema rejects such a tag, so this only guards a hand-edited rule.
    expect(describeActions([{ tag: '!!!', type: 'addTag' }])).toBe('add tag "!!!"')
    expect(describeActions([{ tag: '!!!', type: 'removeTag' }])).toBe('remove tag "!!!"')
  })

  test('renders an unrecognised action type as "unknown action"', () => {
    const fromFuture = { type: 'snooze' } as unknown as MailRuleAction
    expect(describeActions([fromFuture])).toBe('unknown action')
  })

  test('renders an empty action list as an empty string', () => {
    expect(describeActions([])).toBe('')
  })
})

describe('formatMailRule', () => {
  test('leads with the index, id and name, and repeats the conditions on the "when" line', () => {
    expect(formatMailRule(1, rule())).toBe(
      '1. [rule-00000001] Archive Billing\n' +
        '   when ALL of: sender contains "billing@example.com"\n' +
        '   then: archive\n' +
        `   created: ${NOW}`
    )
  })

  test('falls back to the conditions as the title when the rule has no name', () => {
    // The title then repeats the "when" line verbatim.
    const lines = formatMailRule(2, rule({ name: undefined })).split('\n')
    expect(lines[0]).toBe('2. [rule-00000001] sender contains "billing@example.com"')
    expect(lines[1]).toBe('   when ALL of: sender contains "billing@example.com"')
  })

  test('marks a disabled rule in the title', () => {
    expect(formatMailRule(1, rule({ enabled: false })).split('\n')[0]).toBe(
      '1. [rule-00000001] Archive Billing (disabled)'
    )
  })

  test('says ANY when the rule matches any condition', () => {
    const lines = formatMailRule(1, rule({ match: 'any' })).split('\n')
    expect(lines[1]).toBe('   when ANY of: sender contains "billing@example.com"')
  })

  test('omits the created line entirely when the rule has no createdAt', () => {
    const formatted = formatMailRule(1, rule({ createdAt: undefined, updatedAt: undefined }))
    expect(formatted.split('\n')).toHaveLength(3)
    expect(formatted).not.toContain('created:')
  })

  test('shows modified only when updatedAt differs from createdAt', () => {
    const changed = rule({ createdAt: NOW, updatedAt: '2026-08-01T09:30:00.000Z' })
    expect(formatMailRule(1, changed)).toContain(`   created: ${NOW}, modified: 2026-08-01T09:30:00.000Z`)
    expect(formatMailRule(1, rule())).toContain(`   created: ${NOW}\n`.trimEnd())
    expect(formatMailRule(1, rule())).not.toContain('modified:')
  })

  test('omits modified when updatedAt is absent but createdAt is present', () => {
    expect(formatMailRule(1, rule({ updatedAt: undefined }))).not.toContain('modified:')
  })

  test('drops a createdAt-less rule that still carries updatedAt', () => {
    // updatedAt only ever renders inside the created line, so it is invisible
    // without a createdAt.
    const formatted = formatMailRule(1, rule({ createdAt: undefined, updatedAt: '2026-08-01T09:30:00.000Z' }))
    expect(formatted).not.toContain('2026-08-01T09:30:00.000Z')
  })
})

describe('formatEstimate', () => {
  test('reports messages and conversations for a mailbox-wide scope', () => {
    expect(formatEstimate({ capped: false, conversations: 3, messages: 7 }, 'all')).toBe(
      'Approximately 7 existing message(s) match (3 conversation(s)).'
    )
  })

  test('names the Inbox when the scope is inbox', () => {
    expect(formatEstimate({ capped: false, conversations: 3, messages: 7 }, 'inbox')).toBe(
      'Approximately 7 existing Inbox message(s) match (3 conversation(s)).'
    )
  })

  test('suffixes both counts with + when the count hit the query window', () => {
    expect(formatEstimate({ capped: true, conversations: 3, messages: 7 }, 'inbox')).toBe(
      'Approximately 7+ existing Inbox message(s) match (3+ conversation(s)).'
    )
  })

  test('reports a zero match without special-casing it', () => {
    expect(formatEstimate({ capped: false, conversations: 0, messages: 0 }, 'all')).toBe(
      'Approximately 0 existing message(s) match (0 conversation(s)).'
    )
  })
})

describe('formatApplyResult', () => {
  test('omits the failed clause when nothing failed', () => {
    expect(formatApplyResult({ failed: 0, matched: 2, modified: 2, skippedActions: [] })).toBe(
      'Applied to existing mail: 2 messages matched, 2 modified.'
    )
  })

  test('pluralises the matched count but leaves modified as a bare number', () => {
    expect(formatApplyResult({ failed: 0, matched: 1, modified: 1, skippedActions: [] })).toBe(
      'Applied to existing mail: 1 message matched, 1 modified.'
    )
  })

  test('adds the failed clause only when something failed', () => {
    expect(formatApplyResult({ failed: 3, matched: 5, modified: 2, skippedActions: [] })).toBe(
      'Applied to existing mail: 5 messages matched, 2 modified, 3 failed.'
    )
  })

  test('lists actions that only future mail can get', () => {
    expect(
      formatApplyResult({ failed: 0, matched: 2, modified: 2, skippedActions: ['forward', 'stopProcessing'] })
    ).toBe(
      'Applied to existing mail: 2 messages matched, 2 modified.\n' +
        'Not applied to existing mail (future mail only): forward, stopProcessing.'
    )
  })

  test('says zero messages matched rather than staying silent', () => {
    expect(formatApplyResult({ failed: 0, matched: 0, modified: 0, skippedActions: [] })).toBe(
      'Applied to existing mail: 0 messages matched, 0 modified.'
    )
  })
})
