// Quote the message being answered below a reply, the way a mail client does.
//
// A reply in an ongoing conversation is expected to carry the history: the new
// text first, then an attribution line ("On …, Name <address> wrote:") and the
// original body — `>`-prefixed in the plain-text part, inside a
// `<blockquote type="cite">` in the HTML part (what Apple Mail and Thunderbird
// write, and what clients collapse as quoted history). The
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

import { draftFromRecord } from './draft-common.ts'

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

// Block-level boundaries become line breaks before the tags are dropped, so a
// flattened HTML body keeps its paragraphs instead of running together.
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

const htmlToText = (html: string): string =>
  sanitizeHtml(html.replace(BLOCK_BREAK_RE, '\n'), { allowedAttributes: {}, allowedTags: [] })
    .replace(ENTITY_RE, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\n{3,}/gu, '\n\n')
    .trim()

// The original's HTML as it can sit inside the reply's blockquote: only the
// <body> content (a nested <html>/<head> is not valid inside a blockquote), with
// anything active removed. The reply is the user's own message going out under
// their name, so a sender's script or form must not ride along in it.
const BODY_CONTENT_RE = /<body[^>]*>([\s\S]*)<\/body>/iu
const CID_SRC_RE = /^cid:/iu
const ACTIVE_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link'])
const EVENT_ATTRIBUTE_RE = /^on/iu

const quotableHtml = (html: string): string => {
  const body = BODY_CONTENT_RE.exec(html)?.[1] ?? html
  return sanitizeHtml(body, {
    allowedAttributes: false,
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedTags: false,
    allowVulnerableTags: true,
    // An inline image of the original is not carried over as an attachment, so
    // its `cid:` reference would render as a broken image.
    exclusiveFilter: (frame) =>
      ACTIVE_TAGS.has(frame.tag) || (frame.tag === 'img' && CID_SRC_RE.test(frame.attribs.src ?? '')),
    nonTextTags: ['script', 'style', 'textarea', 'noscript', 'title'],
    transformTags: {
      '*': (tagName, attribs) => ({
        attribs: Object.fromEntries(Object.entries(attribs).filter(([name]) => !EVENT_ATTRIBUTE_RE.test(name))),
        tagName,
      }),
    },
  }).trim()
}

const TRAILING_SPACE_RE = /\s+$/u
const LINE_BREAK_RE = /\r?\n/u
const LINE_BREAKS_RE = /\r?\n/gu

const textAsHtml = (text: string): string => escapeHtml(text).replace(LINE_BREAKS_RE, '<br>')

const quoteText = (text: string): string =>
  text
    .replace(TRAILING_SPACE_RE, '')
    .split(LINE_BREAK_RE)
    .map((line) => (line === '' || line.startsWith('>') ? `>${line}` : `> ${line}`))
    .join('\n')

// The reply body with the original quoted below it. Returns the body unchanged
// when the original has nothing to quote (no body part came back).
export const withQuotedOriginal = (body: ReplyBody, original: EmailComposeRecord): ReplyBody => {
  const { html: originalHtml, text: originalText } = draftFromRecord(original)
  const hasText = originalText !== undefined && originalText.trim() !== ''
  const hasHtml = originalHtml !== undefined && originalHtml.trim() !== ''
  if (!(hasText || hasHtml)) {
    return body
  }
  const attribution = attributionLine(original)
  const out: ReplyBody = {}
  if (body.text !== undefined) {
    const quoted = hasText ? originalText : htmlToText(originalHtml ?? '')
    out.text = `${body.text.replace(TRAILING_SPACE_RE, '')}\n\n${quoteText(attribution)}\n>\n${quoteText(quoted)}\n`
  }
  if (body.html !== undefined) {
    const quoted = hasHtml ? quotableHtml(originalHtml ?? '') : textAsHtml(originalText ?? '')
    out.html =
      `${body.html}\n<br>\n<div>${escapeHtml(attribution)}</div>\n` +
      `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quoted}</blockquote>\n`
  }
  return out
}
