import { describe, expect, test } from 'bun:test'

import { type EmailComposeRecord, type IdentityRecord } from '@langmail/jmap'

import {
  draftFromRecord,
  formatDraft,
  isDraft,
  parseAddress,
  parseRecipients,
  replyRecipients,
  replySubject,
  replyThreading,
  resolveIdentity,
} from './draft-common.ts'
import { draftDeps } from './draft-test-fixtures.ts'

describe('parseAddress', () => {
  test('accepts a bare address', () => {
    expect(parseAddress('nadia@example.org')).toEqual({ email: 'nadia@example.org' })
    expect(parseAddress('  nadia@example.org  ')).toEqual({ email: 'nadia@example.org' })
  })

  test('accepts the "Name <address>" form search_contacts returns', () => {
    expect(parseAddress('Nadia Bram <nadia@example.org>')).toEqual({ email: 'nadia@example.org', name: 'Nadia Bram' })
    expect(parseAddress('"Bram, Nadia" <nadia@example.org>')).toEqual({
      email: 'nadia@example.org',
      name: 'Bram, Nadia',
    })
  })

  test('accepts angle brackets with no display name', () => {
    expect(parseAddress('<nadia@example.org>')).toEqual({ email: 'nadia@example.org' })
  })

  test('rejects anything that is not an address', () => {
    for (const bad of ['', 'Nadia Bram', 'nadia@', '@example.org', 'nadia@localhost', 'a b@example.org']) {
      expect(parseAddress(bad)).toBeNull()
    }
  })
})

describe('parseRecipients', () => {
  test('reports every malformed address across all three fields at once', () => {
    const parsed = parseRecipients({ bcc: ['nope'], cc: ['also bad'], to: ['ok@example.org'] })
    expect('error' in parsed).toBe(true)
    if ('error' in parsed) {
      expect(parsed.error).toContain('nope')
      expect(parsed.error).toContain('also bad')
    }
  })

  test('distinguishes an omitted field from an explicitly emptied one', () => {
    const parsed = parseRecipients({ cc: [], to: ['ok@example.org'] })
    expect(parsed).toEqual({ cc: [], to: [{ email: 'ok@example.org' }] })
    // `bcc` was not supplied at all, so it must not appear — that's what lets
    // update_draft tell "keep it" apart from "clear it".
    expect('bcc' in parsed).toBe(false)
  })
})

const identities: IdentityRecord[] = [
  { email: 'user@langmail.me', id: 'i1', name: 'Dana Okonjo' },
  { email: 'sales@langmail.me', id: 'i2' },
]

describe('resolveIdentity', () => {
  test('defaults to the authenticated principal and uses the stored display name', async () => {
    const resolved = await resolveIdentity(draftDeps({ identities }), {
      accountId: 'acct',
      authorization: 'Bearer tok',
      principal: 'user@langmail.me',
    })
    expect(resolved).toEqual({ address: { email: 'user@langmail.me', name: 'Dana Okonjo' }, identityId: 'i1' })
  })

  test('selects an alias by address, case-insensitively', async () => {
    const resolved = await resolveIdentity(draftDeps({ identities }), {
      accountId: 'acct',
      authorization: 'Bearer tok',
      from: 'SALES@langmail.me',
      principal: 'user@langmail.me',
    })
    expect(resolved).toEqual({ address: { email: 'sales@langmail.me' }, identityId: 'i2' })
  })

  test('refuses an address the account cannot send as, and names the ones it can', async () => {
    const resolved = await resolveIdentity(draftDeps({ identities }), {
      accountId: 'acct',
      authorization: 'Bearer tok',
      from: 'someone@example.org',
      principal: 'user@langmail.me',
    })
    expect('error' in resolved).toBe(true)
    if ('error' in resolved) {
      expect(resolved.error).toContain('cannot send as someone@example.org')
      expect(resolved.error).toContain('sales@langmail.me')
    }
  })

  test('falls back to the first identity when the principal is not one of them', async () => {
    const resolved = await resolveIdentity(draftDeps({ identities }), {
      accountId: 'acct',
      authorization: 'Bearer tok',
      principal: 'aliased-login@langmail.me',
    })
    expect(resolved).toEqual({ address: { email: 'user@langmail.me', name: 'Dana Okonjo' }, identityId: 'i1' })
  })

  test('errors when the account has no identity at all', async () => {
    const resolved = await resolveIdentity(draftDeps({ identities: [] }), {
      accountId: 'acct',
      authorization: 'Bearer tok',
      principal: 'user@langmail.me',
    })
    expect('error' in resolved).toBe(true)
  })
})

const original: EmailComposeRecord = {
  cc: [{ email: 'carl@example.org' }, { email: 'user@langmail.me' }],
  from: [{ email: 'nadia@example.org', name: 'Nadia Bram' }],
  id: 'e1',
  messageId: ['orig@example.org'],
  references: ['first@example.org'],
  subject: 'Quarterly numbers',
  to: [{ email: 'user@langmail.me' }, { email: 'tomas@example.com' }],
}

describe('replyRecipients', () => {
  test('replies to the sender only by default', () => {
    expect(replyRecipients(original, 'user@langmail.me', false)).toEqual({
      cc: [],
      to: [{ email: 'nadia@example.org', name: 'Nadia Bram' }],
    })
  })

  test('reply-all folds the original To and Cc into Cc, minus the user', () => {
    const { cc, to } = replyRecipients(original, 'user@langmail.me', true)
    expect(to).toEqual([{ email: 'nadia@example.org', name: 'Nadia Bram' }])
    expect(cc).toEqual([{ email: 'tomas@example.com' }, { email: 'carl@example.org' }])
    // The user is never mailed their own reply.
    expect(JSON.stringify(cc)).not.toContain('user@langmail.me')
  })

  test('prefers Reply-To over From when the sender set one', () => {
    const withReplyTo: EmailComposeRecord = { ...original, replyTo: [{ email: 'desk@example.org' }] }
    expect(replyRecipients(withReplyTo, 'user@langmail.me', false).to).toEqual([{ email: 'desk@example.org' }])
  })

  test('never lists the same address twice, even across To and Cc', () => {
    const dupes: EmailComposeRecord = {
      ...original,
      cc: [{ email: 'Tomas@example.com' }],
      to: [{ email: 'tomas@example.com' }],
    }
    expect(replyRecipients(dupes, 'user@langmail.me', true).cc).toEqual([{ email: 'tomas@example.com' }])
  })

  test('yields no recipient when the original has no sender to reply to', () => {
    expect(replyRecipients({ id: 'e1' }, 'user@langmail.me', true).to).toEqual([])
  })
})

describe('replySubject', () => {
  test('prefixes "Re:" once', () => {
    expect(replySubject('Quarterly numbers')).toBe('Re: Quarterly numbers')
    expect(replySubject('Re: Quarterly numbers')).toBe('Re: Quarterly numbers')
    expect(replySubject('RE:Quarterly numbers')).toBe('RE:Quarterly numbers')
  })

  test('handles a missing subject', () => {
    expect(replySubject(null)).toBe('Re:')
    expect(replySubject('   ')).toBe('Re:')
  })
})

describe('replyThreading', () => {
  test('sets In-Reply-To to the original and appends it to References', () => {
    expect(replyThreading(original)).toEqual({
      inReplyTo: ['orig@example.org'],
      references: ['first@example.org', 'orig@example.org'],
    })
  })

  test('does not repeat a message id already in References', () => {
    const already: EmailComposeRecord = { ...original, references: ['first@example.org', 'orig@example.org'] }
    expect(replyThreading(already).references).toEqual(['first@example.org', 'orig@example.org'])
  })

  test('degrades to empty headers when the original has no Message-ID', () => {
    expect(replyThreading({ id: 'e1' })).toEqual({ inReplyTo: [], references: [] })
  })
})

describe('draftFromRecord', () => {
  test('reads the staged text and html bodies back out of their part values', () => {
    const record: EmailComposeRecord = {
      bodyValues: { '1': { value: 'plain body' }, '2': { value: '<p>rich body</p>' } },
      from: [{ email: 'user@langmail.me' }],
      htmlBody: [{ partId: '2', type: 'text/html' }],
      id: 'd1',
      subject: 'Hello',
      textBody: [{ partId: '1', type: 'text/plain' }],
      to: [{ email: 'nadia@example.org' }],
    }
    expect(draftFromRecord(record)).toEqual({
      from: [{ email: 'user@langmail.me' }],
      html: '<p>rich body</p>',
      subject: 'Hello',
      text: 'plain body',
      to: [{ email: 'nadia@example.org' }],
    })
  })

  test('does not read an html part back as the text body', () => {
    // RFC 8621's textBody falls back to the html part on an html-only message.
    // Taking that as `text` would turn a re-staged draft into plain-text markup.
    const record: EmailComposeRecord = {
      bodyValues: { '2': { value: '<p>rich body</p>' } },
      from: [{ email: 'user@langmail.me' }],
      htmlBody: [{ partId: '2', type: 'text/html' }],
      id: 'd1',
      textBody: [{ partId: '2', type: 'text/html' }],
    }
    const draft = draftFromRecord(record)
    expect(draft.html).toBe('<p>rich body</p>')
    expect(draft.text).toBeUndefined()
  })

  test('round-trips bcc, which get_email never shows', () => {
    const record: EmailComposeRecord = {
      bcc: [{ email: 'quiet@example.org' }],
      from: [{ email: 'user@langmail.me' }],
      id: 'd1',
    }
    expect(draftFromRecord(record).bcc).toEqual([{ email: 'quiet@example.org' }])
  })
})

describe('isDraft', () => {
  test('keys off the $draft keyword, not the mailbox', () => {
    expect(isDraft({ id: 'd1', keywords: { $draft: true } })).toBe(true)
    expect(isDraft({ id: 'd1', keywords: { $seen: true } })).toBe(false)
    expect(isDraft({ id: 'd1' })).toBe(false)
  })
})

describe('formatDraft', () => {
  test('reports the resolved recipients and a body preview', () => {
    const text = formatDraft(
      {
        bcc: [{ email: 'quiet@example.org' }],
        cc: [{ email: 'carl@example.org' }],
        from: [{ email: 'user@langmail.me', name: 'Dana Okonjo' }],
        subject: 'Quarterly numbers',
        text: 'Here they are.',
        to: [{ email: 'nadia@example.org', name: 'Nadia Bram' }],
      },
      { threadId: 't1' }
    )
    // The id line belongs to the caller — see formatDraft's contract.
    expect(text).not.toContain('draftId')
    expect(text).toContain('from: Dana Okonjo <user@langmail.me>')
    expect(text).toContain('to: Nadia Bram <nadia@example.org>')
    expect(text).toContain('cc: carl@example.org')
    expect(text).toContain('bcc: quiet@example.org')
    expect(text).toContain('subject: Quarterly numbers')
    expect(text).toContain('threadId: t1')
    expect(text).toContain('body (text): Here they are.')
  })

  test('truncates a long body and says the draft is threaded', () => {
    const text = formatDraft({
      from: [{ email: 'user@langmail.me' }],
      inReplyTo: ['orig@example.org'],
      text: 'x'.repeat(2000),
    })
    expect(text).toContain('threading: In-Reply-To/References set')
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(1000)
  })

  test('names the empty and html-only cases rather than showing a blank line', () => {
    expect(formatDraft({ from: [{ email: 'user@langmail.me' }], text: '' })).toContain('body (text): (empty)')
    expect(formatDraft({ from: [{ email: 'user@langmail.me' }], html: '<p>hi</p>' })).toContain(
      'body (html): <p>hi</p>'
    )
    expect(formatDraft({ from: [{ email: 'user@langmail.me' }], text: 'hi' })).toContain('to: (none)')
  })
})
