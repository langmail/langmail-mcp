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

import { type EmailComposeRecord } from '@langmail/jmap'

import { DATA_IMAGE_RE } from '../email-render/sanitize.ts'
import { bodyTruncated, draftFromRecord, MAX_DRAFT_BODY_VALUE_BYTES, type ParsedRecipients } from './draft-common.ts'

export interface ReplyBody {
  html?: string
  text?: string
}

const ESCAPES: Record<string, string> = { '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const escapeHtml = (text: string): string => text.replace(/[&<>"]/gu, (c) => ESCAPES[c] ?? c)

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

const formatAttributionDate = (iso: string): string | null => {
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
  const when = original.receivedAt ? formatAttributionDate(original.receivedAt) : null
  return when ? `On ${when}, ${who} wrote:` : `${who} wrote:`
}

const TRAILING_SPACE_RE = /\s+$/u
const LINE_BREAK_RE = /\r?\n/u
const LINE_BREAKS_RE = /\r?\n/gu

// Block-level boundaries become line breaks before the tags are dropped, so a
// flattened HTML body keeps its paragraphs instead of running together.
const BLANK_RUN_RE = /\n{3,}/gu
const BLOCK_BREAK_RE = /<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6]|blockquote)>/giu
const ENTITY_RE = /&(?:amp|lt|gt|quot|#39|nbsp);/gu
const ENTITIES: Record<string, string> = {
  '&#39;': "'",
  '&amp;': '&',
  '&gt;': '>',
  '&lt;': '<',
  '&nbsp;': ' ',
  '&quot;': '"',
}

const LINE_SPACE_RE = /[ \t]+/gu

const htmlToText = (html: string): string =>
  sanitizeHtml(html.replace(BLOCK_BREAK_RE, '\n'), {
    allowedAttributes: {},
    allowedTags: [],
    nonTextTags: ['script', 'style', 'textarea', 'noscript', 'title', 'head'],
  })
    .replace(ENTITY_RE, (entity) => ENTITIES[entity] ?? entity)
    .split(LINE_BREAK_RE)
    .map((line) => line.replace(LINE_SPACE_RE, ' ').trim())
    .join('\n')
    .replace(BLANK_RUN_RE, '\n\n')
    .trim()

// The original's HTML as it can sit inside the reply's blockquote. The reply is
// the user's own message going out under their name, so this is an allowlist,
// not a denylist: presentational markup and inline styles survive, while
// anything active — scripts, forms, frames — and any <style> sheet, which is not
// scoped to the blockquote and could restyle or hide the user's own text above
// it, is dropped. Only the <body> content is kept; a nested <html>/<head> is not
// valid inside a blockquote.
const BODY_CONTENT_RE = /<body[^>]*>([\s\S]*)<\/body>/iu
const HEAD_RE = /<head[^>]*>[\s\S]*?<\/head>/iu
const PRESENTATION_ATTRIBUTES = ['align', 'valign', 'bgcolor', 'width', 'height', 'border', 'dir', 'style']

// Inline styles stay — email layout leans on them — minus the declarations
// that take quoted content out of the blockquote's flow or hide it: a
// `position:fixed` box can cover the user's own text above the quote, and
// `display:none` ships text the user never sees under their name.
const UNQUOTABLE_STYLE_RE =
  /^(?:position|inset|top|right|bottom|left|z-index|transform|visibility|opacity|clip|clip-path)$/u
const HIDDEN_DISPLAY_RE = /^display\s*:\s*none\b/iu

const quotableStyle = (style: string): string =>
  style
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const property = declaration.split(':')[0]?.trim().toLowerCase() ?? ''
      return declaration !== '' && !UNQUOTABLE_STYLE_RE.test(property) && !HIDDEN_DISPLAY_RE.test(declaration)
    })
    .join(';')

const quotableImageSrc = (src: string | undefined): boolean =>
  Boolean(src) && (!src?.toLowerCase().startsWith('data:') || DATA_IMAGE_RE.test(src))

const quotableHtml = (html: string): string => {
  const body = BODY_CONTENT_RE.exec(html)?.[1] ?? html.replace(HEAD_RE, '')
  return sanitizeHtml(body, {
    allowedAttributes: {
      '*': PRESENTATION_ATTRIBUTES,
      a: ['href', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      td: ['colspan', 'rowspan', ...PRESENTATION_ATTRIBUTES],
      th: ['colspan', 'rowspan', ...PRESENTATION_ATTRIBUTES],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'font', 'center', 'span'],
    // An inline image of the original is not carried over as an attachment, so
    // its `cid:` src is refused by the scheme list above — and an <img> with
    // nothing left to show is dropped rather than rendered as a broken box. A
    // `data:` image must be a raster one: SVG can carry markup (see
    // email-render/sanitize.ts).
    exclusiveFilter: (frame) => frame.tag === 'img' && !quotableImageSrc(frame.attribs.src),
    nonTextTags: ['script', 'style', 'textarea', 'noscript', 'title', 'head'],
    transformTags: {
      '*': (tagName, attribs) => {
        if (attribs.style === undefined) {
          return { attribs, tagName }
        }
        const { style, ...rest } = attribs
        const kept = quotableStyle(style)
        return { attribs: kept === '' ? rest : { ...rest, style: kept }, tagName }
      },
    },
  }).trim()
}

const textAsHtml = (text: string): string => escapeHtml(text).replace(LINE_BREAKS_RE, '<br>')

const quoteText = (text: string): string =>
  text
    .replace(TRAILING_SPACE_RE, '')
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
const MAX_REPLY_PART_CHARS = MAX_DRAFT_BODY_VALUE_BYTES / 4
// Room for the attribution, the shortened note, and the markup around them.
const QUOTE_FRAME_CHARS = 1000
const SHORTENED_NOTE = '[… quoted message shortened]'

// Render as much of `value` as fits in `budget` characters once rendered.
// Rendering grows the text unevenly (`> ` prefixes, HTML escaping), so the cut
// is found by shrinking until the output fits rather than computed up front.
const fitted = (
  value: string,
  render: (value: string) => string,
  budget: number
): { rendered: string; shortened: boolean } => {
  let limit = Math.min(value.length, MAX_QUOTE_CHARS)
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
    [...(original.from ?? []), ...(original.replyTo ?? []), ...(original.to ?? []), ...(original.cc ?? [])]
      .map((address) => address.email)
      .concat(selfAddresses)
      .map((email) => email.toLowerCase())
  )
  const named = [...(recipients.to ?? []), ...(recipients.cc ?? []), ...(recipients.bcc ?? [])]
  return named.find((address) => !roster.has(address.email.toLowerCase()))?.email ?? null
}

// The line a result carries when the default withheld the quote, so the agent
// learns it at the moment it matters rather than only from the description.
const quoteWithheldNote = (outsider: string): string =>
  `The original was not quoted: ${outsider} was not on it, and quoting would forward it to them. ` +
  'Pass `quoteOriginal: true` if the user wants it included.'

interface QuoteSource {
  attribution: string
  html: string | undefined
  text: string | undefined
  truncated: boolean
}

const quoteTextPart = (own: string, q: QuoteSource): string => {
  const trimmed = own.replace(TRAILING_SPACE_RE, '')
  const budget = MAX_REPLY_PART_CHARS - trimmed.length - QUOTE_FRAME_CHARS
  if (budget <= 0) {
    return own
  }
  const quoted = fitted(q.text ?? htmlToText(q.html ?? ''), quoteText, budget)
  const note = quoted.shortened || q.truncated ? `\n>\n> ${SHORTENED_NOTE}` : ''
  return `${trimmed}\n\n${quoteText(q.attribution)}\n>\n${quoted.rendered}${note}\n`
}

const quoteHtmlPart = (own: string, q: QuoteSource): string => {
  const budget = MAX_REPLY_PART_CHARS - own.length - QUOTE_FRAME_CHARS
  if (budget <= 0) {
    return own
  }
  const quoted = q.html === undefined ? fitted(q.text ?? '', textAsHtml, budget) : fitted(q.html, quotableHtml, budget)
  const note = quoted.shortened || q.truncated ? `<p>${escapeHtml(SHORTENED_NOTE)}</p>` : ''
  return (
    `${own}\n<br>\n<div>${escapeHtml(q.attribution)}</div>\n` +
    `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quoted.rendered}${note}</blockquote>\n`
  )
}

const nonBlank = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim() !== '' ? value : undefined

// The reply body with the original quoted below it. Returns the body unchanged
// when the original has nothing to quote (no body part came back). A read cut
// off at the body budget is quoted as far as it goes, and says so.
export const withQuotedOriginal = (body: ReplyBody, original: EmailComposeRecord): ReplyBody => {
  const parts = draftFromRecord(original)
  const source: QuoteSource = {
    attribution: attributionLine(original),
    html: nonBlank(parts.html),
    text: nonBlank(parts.text),
    truncated: bodyTruncated(original),
  }
  if (source.text === undefined && source.html === undefined) {
    return body
  }
  return {
    ...(body.text === undefined ? {} : { text: quoteTextPart(body.text, source) }),
    ...(body.html === undefined ? {} : { html: quoteHtmlPart(body.html, source) }),
  }
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
