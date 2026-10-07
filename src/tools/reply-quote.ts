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

import { bodyTruncated, draftFromRecord, type ParsedRecipients } from './draft-common.ts'

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
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'font', 'center', 'span'],
    // An inline image of the original is not carried over as an attachment, so
    // its `cid:` src is refused by the scheme list above — and an <img> with
    // nothing left to show is dropped rather than rendered as a broken box.
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
    nonTextTags: ['script', 'style', 'textarea', 'noscript', 'title', 'head'],
  }).trim()
}

const textAsHtml = (text: string): string => escapeHtml(text).replace(LINE_BREAKS_RE, '<br>')

const quoteText = (text: string): string =>
  text
    .replace(TRAILING_SPACE_RE, '')
    .split(LINE_BREAK_RE)
    .map((line) => (line === '' || line.startsWith('>') ? `>${line}` : `> ${line}`))
    .join('\n')

// How much of the original a quote carries, per body part. Bounded so a reply
// to a long newsletter stays a reply — and stays within the budget update_draft
// reads a draft back at (MAX_DRAFT_BODY_VALUE_BYTES), past which it refuses to
// edit the draft at all.
export const MAX_QUOTE_CHARS = 50_000
const SHORTENED_NOTE = '[… quoted message shortened]'

const bounded = (value: string, truncated: boolean): { shortened: boolean; value: string } =>
  value.length > MAX_QUOTE_CHARS
    ? { shortened: true, value: value.slice(0, MAX_QUOTE_CHARS) }
    : { shortened: truncated, value }

// Whether a reply quotes the original when the caller did not say. It does,
// unless explicit recipients name someone the original was never addressed
// to: quoting then forwards the whole message to a new person, which is a
// decision the user makes (`quoteOriginal: true`), not a default.
export const quotesByDefault = (original: EmailComposeRecord, recipients: ParsedRecipients): boolean => {
  const roster = new Set(
    [...(original.from ?? []), ...(original.replyTo ?? []), ...(original.to ?? []), ...(original.cc ?? [])].map(
      (address) => address.email.toLowerCase()
    )
  )
  const named = [...(recipients.to ?? []), ...(recipients.cc ?? []), ...(recipients.bcc ?? [])]
  return named.every((address) => roster.has(address.email.toLowerCase()))
}

// The reply body with the original quoted below it. Returns the body unchanged
// when the original has nothing to quote (no body part came back).
export const withQuotedOriginal = (body: ReplyBody, original: EmailComposeRecord): ReplyBody => {
  const { html: originalHtml, text: originalText } = draftFromRecord(original)
  const hasText = originalText !== undefined && originalText.trim() !== ''
  const hasHtml = originalHtml !== undefined && originalHtml.trim() !== ''
  if (!(hasText || hasHtml)) {
    return body
  }
  // A read cut off at the body budget is quoted as far as it goes, and says so.
  const truncated = bodyTruncated(original)
  const attribution = attributionLine(original)
  const out: ReplyBody = {}
  if (body.text !== undefined) {
    const quoted = bounded(hasText ? (originalText ?? '') : htmlToText(originalHtml ?? ''), truncated)
    const note = quoted.shortened ? `\n>\n> ${SHORTENED_NOTE}` : ''
    out.text =
      `${body.text.replace(TRAILING_SPACE_RE, '')}\n\n${quoteText(attribution)}\n>\n` +
      `${quoteText(quoted.value)}${note}\n`
  }
  if (body.html !== undefined) {
    const quoted = bounded(hasHtml ? (originalHtml ?? '') : (originalText ?? ''), truncated)
    const inner = hasHtml ? quotableHtml(quoted.value) : textAsHtml(quoted.value)
    const note = quoted.shortened ? `<p>${escapeHtml(SHORTENED_NOTE)}</p>` : ''
    out.html =
      `${body.html}\n<br>\n<div>${escapeHtml(attribution)}</div>\n` +
      `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}${note}</blockquote>\n`
  }
  return out
}
