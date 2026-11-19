// An HTML body flattened to its words, for wherever a message has to be read
// as text: a quote or forward of an html-only message, the text alternative
// update_draft derives, and the body preview of a draft whose text part is
// blank. Its own module so draft-common can use it without importing
// reply-quote, which imports draft-common.

import sanitizeHtml from 'sanitize-html'

const LINE_BREAK_RE = /\r?\n/u

// Block-level boundaries become line breaks before the tags are dropped, so a
// flattened HTML body keeps its paragraphs instead of running together.
const BLANK_RUN_RE = /\n{3,}/gu
// `<p>`, `<li>` and `<tr>` break on their opening, since their closing tags are
// optional; `<br>` with any attributes.
// The containers' mandatory closings break too, so text after a table or list
// does not join its last line.
// These run on the raw, sender-controlled body before anything is cut to size,
// so an attribute run is bounded and stops at the next `<`: unbounded, a body
// of unterminated tags (`<p <p <p …`) backtracks quadratically and stalls the
// server for minutes. The cost is that a tag with a literal `<` in an
// attribute, or more than 1000 characters of them, yields no break — a joined
// line in the text alternative, never wrong markup.
// `<div>` breaks on its opening, so the first line of an Apple Mail or Gmail
// body does not join the next; its closing breaks only when no block follows,
// so sibling divs are not double-spaced. `<dt>`/`<dd>` like `<li>`.
const BLOCK_BREAK_RE =
  /<br\b[^<>]{0,1000}>|<(?:p|li|tr|div|dt|dd)(?:\s[^<>]{0,1000})?>|<\/div>(?!\s*<(?:p|li|tr|div|table|ul|ol|dl)\b)|<\/(?:table|thead|tbody|ul|ol|dl|h[1-6]|blockquote)>/giu
// Table cells are separated by a space, so a row reads `Qty Price`, not `QtyPrice`.
// Openings too: `</td>` is optional in HTML, and plenty of mail omits it.
const CELL_BREAK_RE = /<\/?t[dh](?:\s[^<>]{0,1000})?>/giu
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
// Elements whose content is never message text. `noscript` is deliberately not
// here: it is the discard path GHSA-x3q4-9hxx-gx8m broke, and as an ordinary
// disallowed tag its content is sanitized like any other text.
export const NON_TEXT_TAGS = ['script', 'style', 'textarea', 'title', 'head']

export const htmlToText = (html: string): string =>
  sanitizeHtml(html.replace(BLOCK_BREAK_RE, '\n').replace(CELL_BREAK_RE, ' '), {
    allowedAttributes: {},
    allowedTags: [],
    nonTextTags: NON_TEXT_TAGS,
  })
    .replace(ENTITY_RE, (entity) => ENTITIES[entity] ?? entity)
    .split(LINE_BREAK_RE)
    .map((line) => line.replace(LINE_SPACE_RE, ' ').trim())
    .join('\n')
    .replace(BLANK_RUN_RE, '\n\n')
    .trim()
