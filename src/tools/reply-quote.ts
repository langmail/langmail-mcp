// Quote the message being answered below a reply, the way a mail client does.
//
// A reply in an ongoing conversation is expected to carry the history: the new
// text first, then an attribution line ("On …, Name <address> wrote:") and the
// original body — `>`-prefixed in the plain-text part, inside a
// `<blockquote type="cite">` below the attribution in the HTML part (what clients
// collapse as quoted history). The
// original's own quoted history comes along unchanged, so the thread keeps
// nesting the way the recipient's client expects.
//
// Each part of the reply quotes into its own form: a text-only reply gets a text
// quote, an html-only reply an HTML quote. When the original lacks the matching
// part, the other one is converted — escaped text into HTML, or HTML flattened
// to text — so a reply never loses the quote just because the two messages
// chose different bodies.

import sanitizeHtml from 'sanitize-html'

import { DATA_IMAGE_RE } from '../email-render/sanitize.ts'
import { type EmailComposeRecord } from '../jmap/index.ts'
import { draftFromRecord, MAX_DRAFT_BODY_VALUE_BYTES, type ParsedRecipients } from './draft-common.ts'
import { htmlToText, NON_TEXT_TAGS } from './html-to-text.ts'

export interface ReplyBody {
  html?: string
  text?: string
}

const ESCAPES: Record<string, string> = { '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }
export const escapeHtml = (text: string): string => text.replace(/[&<>"]/gu, (c) => ESCAPES[c] ?? c)

// Pinned to UTC: the tools have no notion of the user's timezone, and a wrong
// local offset is worse than an explicit "UTC".
const ATTRIBUTION_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  hour: '2-digit',
  hour12: false,
  minute: '2-digit',
  month: 'short',
  timeZone: 'UTC',
  weekday: 'short',
  year: 'numeric',
})

export const formatAttributionDate = (iso: string): string | null => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const parts = Object.fromEntries(ATTRIBUTION_DATE.formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year} at ${parts.hour}:${parts.minute} UTC`
}

// "On Mon, 5 Oct 2026 at 12:00 UTC, Nadia Bram <nadia@example.org> wrote:"
export const attributionLine = (original: EmailComposeRecord): string => {
  const sender = original.from?.[0]
  const named = sender?.name ? `${sender.name} <${sender.email}>` : sender?.email
  const who = named ?? 'The sender'
  // The Date header the sender stamped, not when it reached this mailbox —
  // delayed or imported mail can be hours or years apart.
  const stamp = original.sentAt ?? original.receivedAt
  const when = stamp ? formatAttributionDate(stamp) : null
  return when ? `On ${when}, ${who} wrote:` : `${who} wrote:`
}

const LINE_BREAK_RE = /\r?\n/u
const LINE_BREAKS_RE = /\r?\n/gu

// The original's HTML as it can sit inside the reply's blockquote. The reply is
// the user's own message going out under their name, so this is an allowlist,
// not a denylist: presentational markup and inline styles survive, while
// anything active — scripts, forms, frames — and any <style> sheet, which is not
// scoped to the blockquote and could restyle or hide the user's own text above
// it, is dropped. <html>/<body> are unwrapped and <head> discarded by the
// parser, never located by pattern: a `<body>` inside a script or comment must
// not decide where the message starts.
const PRESENTATION_ATTRIBUTES = ['align', 'valign', 'bgcolor', 'width', 'height', 'border', 'dir', 'style']

// Inline styles are an allowlist too: the presentational properties email
// layout leans on, with values that cannot lift quoted content out of the
// blockquote or shrink it to nothing. Everything else — `position`, any
// `transform`/`translate`, negative or large margins, `text-indent`,
// `visibility`, `display:none`, and any property spelled with a CSS escape —
// is dropped by sanitize-html's style filter, which keeps only what is named
// here, with keywords and units matched case-insensitively, as CSS reads them.
// This is layout integrity of the user's own outbound mail, not a security
// boundary: a sender can still colour text white, but cannot paint over the
// reply above.
// No function that fetches — `url(`, `image-set(` / `-webkit-image-set(` (which
// take a bare, scheme-relative string), `src(` — so quoted styles cannot make
// the recipient's client load anything the image rules would not see. No IE
// `expression(` either.
const SAFE_VALUE = /^(?!.*(?:url|src|image-set|expression)\s*\()[#\w\s.,%'"()/+-]*$/iu
// Margins and padding: non-negative and small. Large vertical padding on an
// inline element paints outside its line box without moving it, so an
// unbounded value is the overlay again. Each unit is bounded by its size, so
// every ceiling lands near 100–200px: 99px/pt, 9em/rem, 9ex/mm, 9% (of the
// width), and 2in/cm — enough for Word's MsoNormal `0in` and `.5in` indents.
const SMALL_LENGTH = String.raw`(?:0|auto|(?:\d{1,2}(?:\.\d+)?|\.\d+)(?:px|pt)|(?:\d(?:\.\d+)?|\.\d+)(?:em|rem|ex|mm|%)|(?:[01](?:\.\d+)?|2(?:\.0+)?|\.\d+)(?:in|cm))`
const SMALL_BOX = new RegExp(String.raw`^${SMALL_LENGTH}(?:\s+${SMALL_LENGTH}){0,3}$`, 'iu')
const POSITIVE = String.raw`(?:0*[1-9]\d*(?:\.\d+)?|0*\.\d*[1-9]\d*)`
const POSITIVE_NUMBER = new RegExp(`^${POSITIVE}$`, 'u')
// Sizes need a unit: unitless lengths are invalid CSS outside line-height.
const POSITIVE_LENGTH = new RegExp(`^(?:auto|${POSITIVE}(?:px|pt|em|rem|ex|in|cm|mm|%))$`, 'iu')
const DISPLAY = /^(?:block|inline|inline-block|table|table-row|table-cell|list-item)$/iu
// Keywords only: a length raises or lowers an inline box by that much, which
// is the overlay again by another route.
const VERTICAL_ALIGN = /^(?:baseline|sub|super|top|text-top|middle|bottom|text-bottom)$/iu
const QUOTABLE_STYLES: Record<string, RegExp[]> = Object.fromEntries([
  ['vertical-align', [VERTICAL_ALIGN]],
  // Keywords that keep the element on the page; `none` is not one of them.
  ['display', [DISPLAY]],
  // A zero line box lets glyphs paint over whatever sits above it.
  ['line-height', [/^normal$/iu, POSITIVE_LENGTH, POSITIVE_NUMBER]],
  ...[
    'background',
    'background-color',
    'border',
    'border-bottom',
    'border-collapse',
    'border-color',
    'border-left',
    'border-radius',
    'border-right',
    'border-spacing',
    'border-style',
    'border-top',
    'border-width',
    'color',
    'font-family',
    'font-style',
    'font-weight',
    'list-style-type',
    'text-align',
    'text-decoration',
    'white-space',
  ].map((property) => [property, [SAFE_VALUE]]),
  ...[
    'margin',
    'margin-bottom',
    'margin-left',
    'margin-right',
    'margin-top',
    'padding',
    'padding-bottom',
    'padding-left',
    'padding-right',
    'padding-top',
  ].map((property) => [property, [SMALL_BOX]]),
  ...['font-size', 'height', 'max-width', 'min-height', 'min-width', 'width'].map((property) => [
    property,
    [POSITIVE_LENGTH],
  ]),
])

// Compared after the same normalization sanitize-html's scheme filter applies —
// it drops control characters and spaces before reading the scheme — so a
// `da<tab>ta:` src cannot pass as "not a data URI" here and as `data:` there.
const SCHEME_NOISE_RE = /[\u0000-\u0020]+/gu

const WEB_SCHEME_RE = /^https?:/iu
const LINK_SCHEME_RE = /^(?:https?|mailto|tel):/iu

// sanitize-html lets a URL with no scheme through (`/pixel`, `logo.png`,
// `//host/x`); in a reply those resolve against the recipient's webmail. Only
// absolute web URLs and raster data images are quoted.
// A forward carries the original's inline parts along, so there a `cid:` src
// still names something the recipient receives.
const CID_SCHEME_RE = /^cid:/iu

const quotableImageSrc = (src: string | undefined, keepCid: boolean): boolean => {
  const normalized = src?.replace(SCHEME_NOISE_RE, '') ?? ''
  return WEB_SCHEME_RE.test(normalized) || DATA_IMAGE_RE.test(normalized) || (keepCid && CID_SCHEME_RE.test(normalized))
}

const quotableHref = (href: string): boolean => LINK_SCHEME_RE.test(href.replace(SCHEME_NOISE_RE, ''))

// sanitize-html matches style properties case-sensitively, so `COLOR:red` from a
// Word export would be dropped; property names are lowercased first.
const STYLE_PROPERTY_RE = /(^|;)\s*([-\w]+)\s*:/gu
const lowercaseStyleProperties = (style: string): string =>
  style.replace(STYLE_PROPERTY_RE, (_, sep: string, property: string) => `${sep}${property.toLowerCase()}:`)

const quotableAttributes = (attribs: sanitizeHtml.Attributes): sanitizeHtml.Attributes => {
  const { href, style, ...rest } = attribs
  return {
    ...rest,
    ...(href !== undefined && quotableHref(href) ? { href } : {}),
    ...(style === undefined ? {} : { style: lowercaseStyleProperties(style) }),
  }
}

// `keepCid` is for a forward, which attaches the inline parts the `cid:` srcs
// point at; a reply does not, so there they would render as broken images.
export const quotableHtml = (body: string, opts: { keepCid?: boolean } = {}): string =>
  sanitizeHtml(body, {
    allowedAttributes: {
      '*': PRESENTATION_ATTRIBUTES,
      a: ['href', 'title'],
      // So a quote of a quote keeps the marker clients collapse history on.
      blockquote: ['type'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      td: ['colspan', 'rowspan', ...PRESENTATION_ATTRIBUTES],
      th: ['colspan', 'rowspan', ...PRESENTATION_ATTRIBUTES],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', ...(opts.keepCid ? ['cid'] : [])] },
    allowedStyles: { '*': QUOTABLE_STYLES },
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'font', 'center', 'span'],
    // In a reply an inline image of the original is not carried over as an
    // attachment, so its `cid:` src is refused by the scheme list above — and
    // an <img> with nothing left to show is dropped rather than rendered as a
    // broken box. A `data:` image must be a raster one: SVG can carry markup
    // (see email-render/sanitize.ts).
    exclusiveFilter: (frame) => frame.tag === 'img' && !quotableImageSrc(frame.attribs.src, opts.keepCid === true),
    nonTextTags: NON_TEXT_TAGS,
    transformTags: { '*': (tagName, attribs) => ({ attribs: quotableAttributes(attribs), tagName }) },
  }).trim()

export const textAsHtml = (text: string): string => escapeHtml(text).replace(LINE_BREAKS_RE, '<br>')

const quoteText = (text: string): string =>
  text
    .trimEnd()
    .split(LINE_BREAK_RE)
    .map((line) => (line === '' || line.startsWith('>') ? `>${line}` : `> ${line}`))
    .join('\n')

// How much of the original a quote carries, per body part — so a reply to a
// long newsletter stays a reply.
export const MAX_QUOTE_CHARS = 50_000
// The longest body part that is guaranteed to read back whole: update_draft
// reads at MAX_DRAFT_BODY_VALUE_BYTES octets, a character costs at most four,
// so 100_000 characters always fit. A staged reply's part — the caller's text
// plus the quote — is kept inside this, or update_draft would find it
// truncated and refuse to edit the draft at all.
export const MAX_REPLY_PART_CHARS = MAX_DRAFT_BODY_VALUE_BYTES / 4
// Room for the shortened note and the markup around the quote; the attribution
// is measured, since it carries the sender's display name.
const QUOTE_FRAME_CHARS = 1000
const SHORTENED_NOTE = '[… quoted message shortened]'

// Render as much of `value` as fits in `budget` characters once rendered.
// Rendering grows the text unevenly (`> ` prefixes, HTML escaping), so the cut
// is found by shrinking until the output fits rather than computed up front.
export const fitted = (
  value: string,
  render: (value: string) => string,
  budget: number,
  // How much of `value` is ever rendered. A reply's quote stops at
  // MAX_QUOTE_CHARS; a forward carries as much as the part budget allows.
  cap: number = MAX_QUOTE_CHARS
): { rendered: string; shortened: boolean } => {
  let limit = Math.min(value.length, cap)
  for (;;) {
    const rendered = render(value.slice(0, limit))
    if (rendered.length <= budget || limit === 0) {
      return { rendered, shortened: limit < value.length }
    }
    limit = Math.max(0, Math.floor((limit * budget) / rendered.length) - 1)
  }
}

// Whether a reply quotes the original when the caller did not say. It does,
// unless explicit recipients name someone the original was never addressed
// to: quoting then forwards the whole message to a new person, which is a
// decision the user makes (`quoteOriginal: true`), not a default. The user's
// own addresses are never outsiders — a self-bcc is not a forward.
export const quoteWithheldFrom = (
  original: EmailComposeRecord,
  recipients: ParsedRecipients,
  selfAddresses: string[]
): string | null => {
  const roster = new Set(
    [
      ...(original.from ?? []),
      ...(original.replyTo ?? []),
      ...(original.to ?? []),
      ...(original.cc ?? []),
      // Present on the user's own sent mail: those people already have it.
      ...(original.bcc ?? []),
    ]
      .map((address) => address.email)
      .concat(selfAddresses)
      .map((email) => email.toLowerCase())
  )
  const named = [...(recipients.to ?? []), ...(recipients.cc ?? []), ...(recipients.bcc ?? [])]
  return named.find((address) => !roster.has(address.email.toLowerCase()))?.email ?? null
}

// The line a result carries when the default withheld the quote, so the agent
// learns it at the moment it matters rather than only from the description.
export const quoteWithheldNote = (outsider: string): string =>
  `The original was not quoted: ${outsider} was not on it, and quoting would forward it to them. ` +
  'Pass `quoteOriginal: true` if the user wants it included.'

interface QuoteSource {
  attribution: string
  html: string | undefined
  htmlTruncated: boolean
  text: string | undefined
  textTruncated: boolean
}

// Whether the body value of one media type came back cut off at the read
// budget — per part, so a complete text part is not marked shortened because
// its HTML alternative was long.
export const partTruncated = (
  record: EmailComposeRecord,
  parts: EmailComposeRecord['textBody'],
  mediaType: string
): boolean =>
  (parts ?? []).some(
    (part) => part.type === mediaType && part.partId && record.bodyValues?.[part.partId]?.isTruncated === true
  )

const quoteTextPart = (own: string, q: QuoteSource): string => {
  const trimmed = own.trimEnd()
  const attribution = quoteText(q.attribution)
  const budget = MAX_REPLY_PART_CHARS - trimmed.length - attribution.length - QUOTE_FRAME_CHARS
  // A reply that already fills the part budget goes out unquoted, as written.
  if (budget <= 0) {
    return own
  }
  const quoted = fitted(q.text ?? htmlToText(q.html ?? ''), quoteText, budget)
  const truncated = q.text === undefined ? q.htmlTruncated : q.textTruncated
  const note = quoted.shortened || truncated ? `\n>\n> ${SHORTENED_NOTE}` : ''
  return `${trimmed}\n\n${attribution}\n>\n${quoted.rendered}${note}\n`
}

const quoteHtmlPart = (own: string, q: QuoteSource): string => {
  const attribution = escapeHtml(q.attribution)
  const budget = MAX_REPLY_PART_CHARS - own.length - attribution.length - QUOTE_FRAME_CHARS
  if (budget <= 0) {
    return own
  }
  // Sanitized before it is cut, so markup the sanitizer discards (a long <head>,
  // an embedded style sheet) cannot spend the budget; re-sanitizing each cut
  // closes whatever tags the cut left open.
  const quoted =
    q.html === undefined ? fitted(q.text ?? '', textAsHtml, budget) : fitted(quotableHtml(q.html), quotableHtml, budget)
  const truncated = q.html === undefined ? q.textTruncated : q.htmlTruncated
  const note = quoted.shortened || truncated ? `<p>${escapeHtml(SHORTENED_NOTE)}</p>` : ''
  return (
    `${own}\n<br>\n<div>${attribution}</div>\n` +
    `<blockquote type="cite" style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">${quoted.rendered}${note}</blockquote>\n`
  )
}

export const nonBlank = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim() !== '' ? value : undefined

// The reply body with the original quoted below it. Returns the body unchanged
// when the original has nothing to quote (no body part came back). A read cut
// off at the body budget is quoted as far as it goes, and says so.
export const withQuotedOriginal = (body: ReplyBody, original: EmailComposeRecord): ReplyBody => {
  const parts = draftFromRecord(original)
  const source: QuoteSource = {
    attribution: attributionLine(original),
    html: nonBlank(parts.html),
    htmlTruncated: partTruncated(original, original.htmlBody, 'text/html'),
    text: nonBlank(parts.text),
    textTruncated: partTruncated(original, original.textBody, 'text/plain'),
  }
  if (source.text === undefined && source.html === undefined) {
    return body
  }
  return {
    ...(body.text === undefined ? {} : { text: quoteTextPart(body.text, source) }),
    ...(body.html === undefined ? {} : { html: quoteHtmlPart(body.html, source) }),
  }
}

// Whether a body already quotes `original` — by its attribution line, which is
// how update_draft tells a reply that carries the quote from a bare one, and a
// caller who passed the whole body (quote included) from one who passed only
// the new part.
export const carriesQuoteOf = (body: ReplyBody, original: EmailComposeRecord): boolean => {
  const attribution = attributionLine(original)
  return Boolean(body.text?.includes(attribution) || body.html?.includes(escapeHtml(attribution)))
}

// The quoting decision both reply paths make: the caller's `quoteOriginal`
// when given, the recipient rule otherwise. Returns the body to stage and,
// when the default withheld the quote, the note the result should carry.
export const quoteReply = (
  body: ReplyBody,
  p: {
    original: EmailComposeRecord
    quoteOriginal: boolean | undefined
    recipients: ParsedRecipients
    selfAddresses: string[]
  }
): { body: ReplyBody; note: string | null } => {
  if (p.quoteOriginal === false) {
    return { body, note: null }
  }
  if (p.quoteOriginal === undefined) {
    const outsider = quoteWithheldFrom(p.original, p.recipients, p.selfAddresses)
    if (outsider) {
      return { body, note: quoteWithheldNote(outsider) }
    }
  }
  return { body: withQuotedOriginal(body, p.original), note: null }
}
