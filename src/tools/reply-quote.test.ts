import { describe, expect, test } from 'bun:test'

import { MAX_DRAFT_BODY_VALUE_BYTES } from './draft-common.ts'
import { receivedMessage } from './draft-test-fixtures.ts'
import { attributionLine, MAX_QUOTE_CHARS, quoteWithheldFrom, withQuotedOriginal } from './reply-quote.ts'

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

const htmlOriginal = (html: string) =>
  receivedMessage({ bodyValues: { '2': { value: html } }, htmlBody: [{ partId: '2', type: 'text/html' }] })

describe('attributionLine', () => {
  test('cites the Date header over the time the message arrived', () => {
    expect(attributionLine({ ...textOnly, receivedAt: '2026-10-06T09:00:00Z', sentAt: RECEIVED_AT })).toContain(
      'On Mon, 5 Oct 2026 at 12:00 UTC'
    )
  })

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

  test('drops a style sheet anywhere in the original, so it cannot restyle the reply above it', () => {
    const original = receivedMessage({
      bodyValues: {
        '2': {
          value:
            '<html><head><title>T</title><style>*{color:red}</style></head><style>p{display:none}</style><p style="color:blue">hi</p></html>',
        },
      },
      htmlBody: [{ partId: '2', type: 'text/html' }],
    })
    const { html } = withQuotedOriginal({ html: '<p>ok</p>' }, original)
    expect(html).not.toContain('<style')
    expect(html).not.toContain('display:none')
    expect(html).not.toContain('<title')
    expect(html).toContain('<p style="color:blue">hi</p>')
  })

  test('keeps raster data images and web links only', () => {
    const original = receivedMessage({
      bodyValues: {
        '2': {
          value:
            '<img src="data:image/svg+xml;base64,PHN2Zz4="><img src="data:image/png;base64,iVBO">' +
            '<a href="ftp://example.org/f">f</a><a href="mailto:nadia@example.org">m</a>',
        },
      },
      htmlBody: [{ partId: '2', type: 'text/html' }],
    })
    const { html } = withQuotedOriginal({ html: '<p>ok</p>' }, original)
    expect(html).not.toContain('svg+xml')
    expect(html).toContain('data:image/png;base64,iVBO')
    expect(html).not.toContain('ftp:')
    expect(html).toContain('href="mailto:nadia@example.org"')
  })

  test('strips inline styles that lift quoted content over the reply or hide it', () => {
    const original = receivedMessage({
      bodyValues: {
        '2': {
          value:
            '<div style="position:fixed;inset:0;z-index:9999;background:#fff">cover</div>' +
            '<p style="display: none">hidden</p><p style="color:blue;display:block">kept</p>',
        },
      },
      htmlBody: [{ partId: '2', type: 'text/html' }],
    })
    const { html } = withQuotedOriginal({ html: '<p>ok</p>' }, original)
    expect(html).toContain('<div style="background:#fff">cover</div>')
    expect(html).toContain('<p>hidden</p>')
    expect(html).toContain('<p style="color:blue;display:block">kept</p>')
  })

  test('keeps presentational styles and drops anything that moves or shrinks quoted content', () => {
    const original = receivedMessage({
      bodyValues: {
        '2': {
          value:
            '<p style="margin-top:-500px;padding:4px 8px">a</p><p style="-webkit-transform:translateY(-500px);translate:0 -500px">b</p>' +
            '<p style="text-indent:-9999px;font-size:0">c</p><p style="\\70 osition:fixed;margin:0 auto;font-size:14px">d</p>',
        },
      },
      htmlBody: [{ partId: '2', type: 'text/html' }],
    })
    const { html } = withQuotedOriginal({ html: '<p>ok</p>' }, original)
    expect(html).toContain('<p style="padding:4px 8px">a</p>')
    expect(html).toContain('<p>b</p>')
    expect(html).toContain('<p>c</p>')
    expect(html).toContain('<p style="margin:0 auto;font-size:14px">d</p>')
  })

  test('keeps vertical-align keywords and positive line heights only', () => {
    const original = receivedMessage({
      bodyValues: {
        '2': {
          value:
            '<span style="vertical-align:600px">a</span><span style="vertical-align:top">b</span>' +
            '<p style="line-height:0">c</p><p style="line-height:1.4">d</p>',
        },
      },
      htmlBody: [{ partId: '2', type: 'text/html' }],
    })
    const { html } = withQuotedOriginal({ html: '<p>ok</p>' }, original)
    expect(html).toContain('<span>a</span>')
    expect(html).toContain('<span style="vertical-align:top">b</span>')
    expect(html).toContain('<p>c</p>')
    expect(html).toContain('<p style="line-height:1.4">d</p>')
  })

  test('keeps a maximal non-ASCII reply plus its quote inside the read-back budget', () => {
    const original = receivedMessage({
      bodyValues: { '1': { value: '数字\n'.repeat(40_000) } },
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    const own = '返信'.repeat(30_000)
    const text = withQuotedOriginal({ text: own }, original).text ?? ''
    expect(text).toStartWith(own)
    expect(text).toContain('[… quoted message shortened]')
    expect(text.length * 4).toBeLessThanOrEqual(MAX_DRAFT_BODY_VALUE_BYTES)
  })

  test('drops a data image whose scheme is disguised with a control character', () => {
    const original = receivedMessage({
      bodyValues: { '2': { value: '<p>hi</p><img src="da&#9;ta:image/svg+xml;base64,PHN2Zz4=">' } },
      htmlBody: [{ partId: '2', type: 'text/html' }],
    })
    expect(withQuotedOriginal({ html: '<p>ok</p>' }, original).html).not.toContain('<img')
  })

  test('keeps table cells apart in the text quote', () => {
    const original = receivedMessage({
      bodyValues: {
        '2': { value: '<table><tr><td>Qty</td><td>Price</td></tr><tr><td class="n">2<td>10</tr></table>' },
      },
      htmlBody: [{ partId: '2', type: 'text/html' }],
    })
    expect(withQuotedOriginal({ text: 'ok' }, original).text).toContain('> Qty Price\n> 2 10')
  })

  test('cuts the quote from the body, not from a long head', () => {
    const original = receivedMessage({
      bodyValues: {
        '2': { value: `<html><head><style>${'p{}'.repeat(30_000)}</style></head><body><p>visible</p></body></html>` },
      },
      htmlBody: [{ partId: '2', type: 'text/html' }],
    })
    expect(withQuotedOriginal({ html: '<p>ok</p>' }, original).html).toContain('<p>visible</p>')
  })

  test('counts a long sender name against the budget', () => {
    const original = receivedMessage({
      bodyValues: { '1': { value: 'x\n'.repeat(40_000) } },
      from: [{ email: 'nadia@example.org', name: 'N'.repeat(60_000) }],
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    const text = withQuotedOriginal({ text: 'y'.repeat(30_000) }, original).text ?? ''
    expect(text).toContain('nadia@example.org')
    expect(text.length * 4).toBeLessThanOrEqual(MAX_DRAFT_BODY_VALUE_BYTES)
  })

  test('keeps only absolute web links and images, and lowercases style properties', () => {
    const original = htmlOriginal(
      '<img src="/pixel"><img src="logo.png"><img src="//example.org/x.png"><img src="https://example.org/ok.png">' +
        '<a href="/account/action">rel</a><a href="https://example.org/">abs</a><p style="COLOR:red">c</p>'
    )
    const { html } = withQuotedOriginal({ html: '<p>ok</p>' }, original)
    expect(html).not.toContain('/pixel')
    expect(html).not.toContain('logo.png')
    expect(html).not.toContain('//example.org/x.png')
    expect(html).toContain('<img src="https://example.org/ok.png" />')
    expect(html).toContain('<a>rel</a>')
    expect(html).toContain('<a href="https://example.org/">abs</a>')
    expect(html).toContain('<p style="color:red">c</p>')
  })

  test('bounds margins and padding, requires units on sizes, and refuses url() backgrounds', () => {
    const original = htmlOriginal(
      '<span style="padding-top:100000px;background-color:white">a</span><p style="font-size:14">b</p>' +
        '<p style="font-size:14px;padding:8px 2em">c</p><td style="background:url(https://example.org/t.gif)">d</td>'
    )
    const { html } = withQuotedOriginal({ html: '<p>ok</p>' }, original)
    expect(html).toContain('<span style="background-color:white">a</span>')
    expect(html).toContain('<p>b</p>')
    expect(html).toContain('<p style="font-size:14px;padding:8px 2em">c</p>')
    expect(html).not.toContain('t.gif')
  })

  test('refuses every fetching background function, and keeps plain ones', () => {
    const { html } = withQuotedOriginal(
      { html: '<p>ok</p>' },
      htmlOriginal(
        '<p style="background:image-set(&quot;//example.org/p.png&quot; 1x)">a</p>' +
          '<p style="background:-webkit-image-set(&quot;//example.org/p.png&quot; 1x)">b</p>' +
          '<p style="background:linear-gradient(red, blue)">c</p>'
      )
    )
    expect(html).not.toContain('example.org/p.png')
    expect(html).toContain('<p style="background:linear-gradient(red, blue)">c</p>')
  })

  test('text after a table or list starts its own line', () => {
    const { text } = withQuotedOriginal(
      { text: 'ok' },
      htmlOriginal('<table><tr><td>Label</td></tr></table>Footer<ul><li>a</li></ul>tail')
    )
    expect(text).toContain('> Label\n> Footer\n> a\n> tail\n')
  })

  test('divs and description lists break where a mail client shows a new line', () => {
    const lines = (html: string) => withQuotedOriginal({ text: 'ok' }, htmlOriginal(html)).text ?? ''
    expect(lines('Hi<div>A</div><div>B</div>')).toContain('> Hi\n> A\n> B\n')
    expect(lines('<div dir="ltr">Hi<div>A</div></div>')).toContain('> Hi\n> A\n')
    expect(lines('<div>A</div>tail')).toContain('> A\n> tail\n')
    expect(lines('<dl><dt>Plan</dt><dd>Pro</dd><dt>Seats</dt><dd>5</dd></dl>')).toContain(
      '> Plan\n> Pro\n> Seats\n> 5\n'
    )
  })

  test('matches style keywords and units in any case, Word units included', () => {
    const { html } = withQuotedOriginal(
      { html: '<p>ok</p>' },
      htmlOriginal(
        '<p style="display:BLOCK;vertical-align:TOP;padding:10PX">a</p>' +
          '<p class=MsoNormal style=\'margin:0in 0in 10.0pt 0in\'>b</p><p style="margin:-5in">c</p>'
      )
    )
    expect(html).toContain('<p style="display:BLOCK;vertical-align:TOP;padding:10PX">a</p>')
    expect(html).toContain('<p style="margin:0in 0in 10.0pt 0in">b</p>')
    expect(html).toContain('<p>c</p>')
  })

  test('flattens a body of unterminated tags in linear time', () => {
    const started = performance.now()
    withQuotedOriginal({ text: 'ok' }, htmlOriginal('<p '.repeat(133_000)))
    withQuotedOriginal({ text: 'ok' }, htmlOriginal('<td '.repeat(100_000)))
    expect(performance.now() - started).toBeLessThan(2000)
  })

  test('bounds every unit of a margin near the same size', () => {
    const { html } = withQuotedOriginal(
      { html: '<p>ok</p>' },
      htmlOriginal(
        '<p style="padding-top:9in">a</p><p style="padding-top:99ex">b</p><p style="padding-top:50%">c</p>' +
          '<p style="margin-left:.5in">d</p><p style="margin:2in 9mm 9% 99pt">e</p>'
      )
    )
    expect(html).toContain('<p>a</p>')
    expect(html).toContain('<p>b</p>')
    expect(html).toContain('<p>c</p>')
    expect(html).toContain('<p style="margin-left:.5in">d</p>')
    expect(html).toContain('<p style="margin:2in 9mm 9% 99pt">e</p>')
  })

  test('trims a long whitespace run in linear time', () => {
    const started = performance.now()
    const original = receivedMessage({
      bodyValues: { '1': { value: `x${' '.repeat(40_000)}y` } },
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    withQuotedOriginal({ text: `a${' '.repeat(40_000)}b` }, original)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test('a quote of its own output keeps the cite marker and the indent', () => {
    const first = withQuotedOriginal({ html: '<p>first</p>' }, htmlOriginal('<p>original</p>')).html ?? ''
    const second = withQuotedOriginal({ html: '<p>second</p>' }, htmlOriginal(first)).html ?? ''
    expect(second.match(/<blockquote type="cite" style="margin:0 0 0 0.8ex/gu)).toHaveLength(2)
  })

  test('spends the budget on content, not on markup the sanitizer drops', () => {
    const original = htmlOriginal(`<body><style>${'p{}'.repeat(30_000)}</style><p>visible</p></body>`)
    expect(withQuotedOriginal({ html: '<p>ok</p>' }, original).html).toContain('<p>visible</p>')
  })

  test('a <body> inside a script does not decide where the message starts', () => {
    const original = htmlOriginal(
      "<html><head><script>const x='<body>'; HIDDEN</script></head><body><p>visible</p></body></html>"
    )
    const { html } = withQuotedOriginal({ html: '<p>ok</p>' }, original)
    expect(html).not.toContain('HIDDEN')
    expect(html).toContain('<p>visible</p>')
  })

  test('breaks lines on attributed <br> and unclosed paragraphs in the text quote', () => {
    const { text } = withQuotedOriginal({ text: 'ok' }, htmlOriginal('A<br class="x">B<p>one<p>two'))
    expect(text).toContain('> A\n> B\n> one\n> two\n')
  })

  test('marks only the part that was actually cut short', () => {
    const original = receivedMessage({
      bodyValues: { '1': { value: 'complete text' }, '2': { isTruncated: true, value: '<p>long html' } },
      htmlBody: [{ partId: '2', type: 'text/html' }],
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    expect(withQuotedOriginal({ text: 'ok' }, original).text).not.toContain('shortened')
    expect(withQuotedOriginal({ html: '<p>ok</p>' }, original).html).toContain('shortened')
  })

  test('marks a quote cut short, whether by the read budget or the quote cap', () => {
    const truncated = receivedMessage({
      bodyValues: { '1': { isTruncated: true, value: 'start of a long message' } },
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    expect(withQuotedOriginal({ text: 'ok' }, truncated).text).toEndWith('> [… quoted message shortened]\n')
    const long = receivedMessage({
      bodyValues: { '1': { value: 'x'.repeat(MAX_QUOTE_CHARS + 10) } },
      textBody: [{ partId: '1', type: 'text/plain' }],
    })
    const text = withQuotedOriginal({ text: 'ok' }, long).text ?? ''
    expect(text).toContain('[… quoted message shortened]')
    expect(text.length).toBeLessThan(MAX_QUOTE_CHARS + 200)
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

describe('quoteWithheldFrom', () => {
  test('names a recipient the original never reached, but never the user themselves', () => {
    const original = receivedMessage()
    expect(quoteWithheldFrom(original, {}, [])).toBeNull()
    expect(quoteWithheldFrom(original, { to: [{ email: 'Tomas@example.com' }] }, [])).toBeNull()
    expect(quoteWithheldFrom(original, { bcc: [{ email: 'alias@langmail.me' }] }, ['alias@langmail.me'])).toBeNull()
    expect(quoteWithheldFrom(original, { to: [{ email: 'outsider@example.net' }] }, [])).toBe('outsider@example.net')
    const sent = receivedMessage({ bcc: [{ email: 'quiet@example.net' }] })
    expect(quoteWithheldFrom(sent, { to: [{ email: 'quiet@example.net' }] }, [])).toBeNull()
  })
})
