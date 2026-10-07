import { describe, expect, test } from 'bun:test'

import { receivedMessage } from './draft-test-fixtures.ts'
import { attributionLine, withQuotedOriginal } from './reply-quote.ts'

const RECEIVED_AT = '2026-10-05T12:00:00Z'

const textOnly = receivedMessage({
  bodyValues: { '1': { value: 'Can you send the numbers?\n\n> Earlier message\n' } },
  receivedAt: RECEIVED_AT,
  textBody: [{ partId: '1', type: 'text/plain' }],
})

const htmlOnly = receivedMessage({
  bodyValues: {
    '2': {
      value:
        '<html><head><style>p{color:red}</style></head><body><p onclick="steal()">Numbers &amp; charts</p>' +
        '<script>steal()</script><img src="cid:logo"><img src="https://example.org/a.png"><p>Thanks</p></body></html>',
    },
  },
  htmlBody: [{ partId: '2', type: 'text/html' }],
  receivedAt: RECEIVED_AT,
  textBody: [{ partId: '2', type: 'text/html' }],
})

describe('attributionLine', () => {
  test('names the sender and the UTC time the original arrived', () => {
    expect(attributionLine(textOnly)).toBe('On Mon, 5 Oct 2026 at 12:00 UTC, Nadia Bram <nadia@example.org> wrote:')
  })

  test('drops the date when the original has none', () => {
    expect(attributionLine(receivedMessage({ from: [{ email: 'nadia@example.org' }] }))).toBe(
      'nadia@example.org wrote:'
    )
  })
})

describe('withQuotedOriginal', () => {
  test('quotes a text original below a text reply, keeping its own history nested', () => {
    expect(withQuotedOriginal({ text: 'Here they are.\n' }, textOnly)).toEqual({
      text:
        'Here they are.\n\n' +
        '> On Mon, 5 Oct 2026 at 12:00 UTC, Nadia Bram <nadia@example.org> wrote:\n' +
        '>\n' +
        '> Can you send the numbers?\n' +
        '>\n' +
        '>> Earlier message\n',
    })
  })

  test('quotes an html original in a cite blockquote, without its scripts, handlers, or cid images', () => {
    const { html } = withQuotedOriginal({ html: '<p>Here they are.</p>' }, htmlOnly)
    expect(html).toStartWith('<p>Here they are.</p>')
    expect(html).toContain('<div>On Mon, 5 Oct 2026 at 12:00 UTC, Nadia Bram &lt;nadia@example.org&gt; wrote:</div>')
    expect(html).toContain('<blockquote type="cite"')
    expect(html).toContain('<p>Numbers &amp; charts</p>')
    expect(html).toContain('https://example.org/a.png')
    expect(html).not.toContain('steal')
    expect(html).not.toContain('cid:logo')
    expect(html).not.toContain('<head>')
  })

  test('flattens an html-only original into the text quote', () => {
    expect(withQuotedOriginal({ text: 'Here they are.' }, htmlOnly).text).toContain('>\n> Numbers & charts\n> Thanks\n')
  })

  test('escapes a text-only original into the html quote', () => {
    const original = receivedMessage({
      bodyValues: { '1': { value: 'a <b> & c\nnext' } },
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    expect(withQuotedOriginal({ html: '<p>ok</p>' }, original).html).toContain('a &lt;b&gt; &amp; c<br>next')
  })

  test('leaves the body alone when the original has nothing to quote', () => {
    expect(withQuotedOriginal({ text: 'Thanks!' }, receivedMessage())).toEqual({ text: 'Thanks!' })
  })
})
