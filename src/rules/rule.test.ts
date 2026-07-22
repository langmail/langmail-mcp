import { describe, expect, test } from 'bun:test'

import { generateSieveScript, type MailRule, mailRuleSchema, parseSieveScript, tagToKeywordSuffix } from './rule.ts'

const rule = (overrides: Partial<MailRule> = {}): MailRule => ({
  actions: { moveTo: 'Archive' },
  conditions: { from: 'notifications@github.com' },
  description: 'Automatically archive all GitHub notifications',
  id: 'rule-1a2b3c4d',
  ...overrides,
})

describe('mailRuleSchema', () => {
  test('rejects a rule with no conditions or no actions', () => {
    expect(mailRuleSchema.safeParse(rule({ conditions: {} })).success).toBe(false)
    expect(mailRuleSchema.safeParse(rule({ actions: {} })).success).toBe(false)
    expect(mailRuleSchema.safeParse(rule()).success).toBe(true)
  })

  test('rejects hasAttachment:false — only positive matches are expressible', () => {
    expect(mailRuleSchema.safeParse(rule({ conditions: { hasAttachment: false } as never })).success).toBe(false)
  })
})

describe('tagToKeywordSuffix', () => {
  test('mirrors the Bulwark tag-id normalization', () => {
    expect(tagToKeywordSuffix('GitHub')).toBe('github')
    expect(tagToKeywordSuffix('Acme Corp')).toBe('acme-corp')
    expect(tagToKeywordSuffix('--Weird__Tag!!')).toBe('weird__tag')
  })

  test('returns null when nothing survives sanitization', () => {
    expect(tagToKeywordSuffix('!!!')).toBeNull()
  })
})

describe('generateSieveScript', () => {
  test('emits the require header, one metadata comment and one if-block per rule', () => {
    const script = generateSieveScript([
      rule(),
      rule({
        actions: { addTags: ['Finance'] },
        conditions: { from: 'stripe.com', subject: 'invoice' },
        description: 'Tag Stripe invoices',
        id: 'rule-ffffffff',
      }),
    ])
    expect(script).toContain('require ["fileinto", "imap4flags", "mailbox", "copy"];')
    expect(script).toContain('# langmail-rule {"actions":{"moveTo":"Archive"}')
    expect(script).toContain('if allof (header :contains "from" "notifications@github.com") {')
    expect(script).toContain('  fileinto :create "Archive";')
    expect(script).toContain('if allof (header :contains "from" "stripe.com", header :contains "subject" "invoice") {')
    expect(script).toContain('  addflag "$label:finance";')
  })

  test('orders flag commands before fileinto so imap4flags apply to the filed copy', () => {
    const script = generateSieveScript([rule({ actions: { addTags: ['github'], markRead: true, moveTo: 'Dev' } })])
    // Two source-level backslashes: the Sieve string "\\Seen" decodes to \Seen.
    const seen = script.indexOf('addflag "\\\\Seen";')
    const tag = script.indexOf('addflag "$label:github";')
    const fileinto = script.indexOf('fileinto :create "Dev";')
    expect(seen).toBeGreaterThan(-1)
    expect(tag).toBeGreaterThan(seen)
    expect(fileinto).toBeGreaterThan(tag)
  })

  test('renders every condition type and forwards with :copy', () => {
    const script = generateSieveScript([
      rule({
        actions: { forwardTo: 'oncall@example.com' },
        conditions: { from: 'Acme Corp', hasAttachment: true, subject: 'contract', to: 'legal@langmail.me' },
      }),
    ])
    expect(script).toContain('header :contains "from" "Acme Corp"')
    expect(script).toContain('header :contains ["to", "cc"] "legal@langmail.me"')
    expect(script).toContain('header :contains "subject" "contract"')
    expect(script).toContain('header :contains "content-type" "multipart/mixed"')
    expect(script).toContain('redirect :copy "oncall@example.com";')
  })

  test('escapes quotes and backslashes in user-supplied strings', () => {
    const script = generateSieveScript([
      rule({ actions: { moveTo: 'Sales "EMEA"' }, conditions: { subject: 'quo"te \\ slash' } }),
    ])
    expect(script).toContain('header :contains "subject" "quo\\"te \\\\ slash"')
    expect(script).toContain('fileinto :create "Sales \\"EMEA\\"";')
  })
})

describe('parseSieveScript', () => {
  test('round-trips generate → parse for a mixed rule list', () => {
    const rules = [
      rule(),
      rule({
        actions: { addTags: ['contracts'], forwardTo: 'oncall@example.com', markRead: true },
        conditions: { hasAttachment: true, subject: 'contract' },
        description: 'Tag and forward contracts',
        id: 'rule-99999999',
      }),
    ]
    expect(parseSieveScript(generateSieveScript(rules))).toEqual(rules)
  })

  test('returns [] for an empty or foreign (hand-written) script', () => {
    expect(parseSieveScript('')).toEqual([])
    expect(parseSieveScript('require ["fileinto"];\nif true { fileinto "X"; }\n')).toEqual([])
  })

  test('skips malformed or invalid metadata lines but keeps the valid ones', () => {
    const good = rule()
    const script = [
      '# langmail-rule not-json{',
      `# langmail-rule ${JSON.stringify({ description: 'no id or shape' })}`,
      `# langmail-rule ${JSON.stringify(good)}`,
    ].join('\n')
    expect(parseSieveScript(script)).toEqual([good])
  })
})
