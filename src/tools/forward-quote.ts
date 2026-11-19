// Build a forward the way a mail client does: the user's note on top, then a
// "Forwarded message" block citing the original's real From, Date, Subject, To
// and Cc, then the original body, in both an HTML and a plain-text part. The
// original's files ride along by blobId, inline images included, so nothing is
// downloaded or re-uploaded and the agent never re-passes any of it.
//
// The block is built here, server-side, from the original's own headers: an
// agent that typed them would get them wrong, which is half of what
// https://github.com/langmail/platform/issues/1201 was about.
//
// A body too long to inline whole is cut to fit — so update_draft can still read
// a staged forward back without truncation — and the whole original then also
// goes along as a `message/rfc822` attachment, by its own blobId, so the
// recipient loses nothing.

import { type DraftAttachment, type EmailComposeRecord, type EmailDraft } from '../jmap/index.ts'
import { attachmentsFromRecord, draftFromRecord } from './draft-common.ts'
import { formatAddressList } from './format.ts'
import { htmlToText } from './html-to-text.ts'
import {
  escapeHtml,
  fitted,
  formatAttributionDate,
  MAX_REPLY_PART_CHARS,
  nonBlank,
  partTruncated,
  quotableHtml,
  type ReplyBody,
  textAsHtml,
} from './reply-quote.ts'

// What Gmail writes, and what other clients recognise as the start of a
// forwarded message.
export const FORWARD_MARKER = '---------- Forwarded message ---------'

const FWD_PREFIX_RE = /^fwd?\s*:/iu

export const forwardSubject = (subject?: string | null): string => {
  const trimmed = (subject ?? '').trim()
  if (!trimmed) {
    return 'Fwd:'
  }
  return FWD_PREFIX_RE.test(trimmed) ? trimmed : `Fwd: ${trimmed}`
}

// The original's references plus its own Message-ID, so the sent copy lands in
// the original's conversation. No In-Reply-To: a forward does not answer the
// message, and clients would show it as a reply if it said so.
export const forwardReferences = (original: EmailComposeRecord): string[] => [
  ...new Set([...(original.references ?? []), ...(original.messageId ?? [])]),
]

// The header block, one "Name: value" per line. Cc only when the original had
// one, as clients do.
const headerLines = (original: EmailComposeRecord): string[] => {
  const stamp = original.sentAt ?? original.receivedAt
  const date = stamp ? formatAttributionDate(stamp) : null
  return [
    `From: ${formatAddressList(original.from) || '(unknown sender)'}`,
    ...(date ? [`Date: ${date}`] : []),
    `Subject: ${original.subject ?? ''}`,
    `To: ${formatAddressList(original.to)}`,
    ...(original.cc && original.cc.length > 0 ? [`Cc: ${formatAddressList(original.cc)}`] : []),
  ]
}

// Room for the header block's markup and the shortened note; the header lines
// themselves are measured, since they carry the original's addresses.
const FRAME_CHARS = 1000
const SHORTENED_NOTE = '[… forwarded message shortened — the full message is attached]'

export interface ForwardBody {
  // Whether the original did not fit whole, so it must also go along as a
  // `message/rfc822` attachment.
  attachOriginal: boolean
  html: string
  text: string
}

// The note in both forms. A note given in one form only is converted for the
// other part, so the two alternatives say the same thing.
const notePart = (note: ReplyBody): { html: string; text: string } => ({
  html: note.html ?? (note.text === undefined ? '' : textAsHtml(note.text)),
  text: note.text ?? (note.html === undefined ? '' : htmlToText(note.html)),
})

const textPart = (
  note: string,
  original: EmailComposeRecord,
  source: { html?: string; text?: string },
  // Set when the other part was cut, so both say the original is attached.
  otherShortened = false
) => {
  const header = [FORWARD_MARKER, ...headerLines(original)].join('\n')
  const lead = note.trimEnd() === '' ? '' : `${note.trimEnd()}\n\n`
  const budget = MAX_REPLY_PART_CHARS - lead.length - header.length - FRAME_CHARS
  const body = source.text ?? htmlToText(source.html ?? '')
  const truncated =
    source.text === undefined
      ? partTruncated(original, original.htmlBody, 'text/html')
      : partTruncated(original, original.textBody, 'text/plain')
  const quoted = fitted(body, (value) => value, Math.max(0, budget), MAX_REPLY_PART_CHARS)
  const shortened = quoted.shortened || truncated || otherShortened
  return {
    shortened,
    text: `${lead}${header}\n\n${quoted.rendered}${shortened ? `\n\n${SHORTENED_NOTE}` : ''}\n`,
  }
}

const htmlPart = (
  note: string,
  original: EmailComposeRecord,
  source: { html?: string; text?: string },
  otherShortened = false
) => {
  const header = `<div>${[FORWARD_MARKER, ...headerLines(original)].map(escapeHtml).join('<br>\n')}</div>`
  const lead = note.trim() === '' ? '' : `${note}\n<br>\n`
  const budget = MAX_REPLY_PART_CHARS - lead.length - header.length - FRAME_CHARS
  const keepCid = (value: string): string => quotableHtml(value, { keepCid: true })
  // Sanitized before it is cut, as a reply's quote is (reply-quote.ts).
  const quoted =
    source.html === undefined
      ? fitted(source.text ?? '', textAsHtml, Math.max(0, budget), MAX_REPLY_PART_CHARS)
      : fitted(keepCid(source.html), keepCid, Math.max(0, budget), MAX_REPLY_PART_CHARS)
  const truncated =
    source.html === undefined
      ? partTruncated(original, original.textBody, 'text/plain')
      : partTruncated(original, original.htmlBody, 'text/html')
  const shortened = quoted.shortened || truncated || otherShortened
  return {
    html: `${lead}${header}\n<br>\n<div>${quoted.rendered}</div>${shortened ? `\n<p>${escapeHtml(SHORTENED_NOTE)}</p>` : ''}\n`,
    shortened,
  }
}

// The forward's body: the note, the header block and the original, in both
// parts whatever form the note and the original came in.
export const forwardedBody = (note: ReplyBody, original: EmailComposeRecord): ForwardBody => {
  const parts = draftFromRecord(original)
  const source = {
    ...(nonBlank(parts.html) === undefined ? {} : { html: parts.html }),
    ...(nonBlank(parts.text) === undefined ? {} : { text: parts.text }),
  }
  const own = notePart(note)
  const firstText = textPart(own.text, original, source)
  const html = htmlPart(own.html, original, source, firstText.shortened)
  const text = html.shortened && !firstText.shortened ? textPart(own.text, original, source, true) : firstText
  return { attachOriginal: text.shortened || html.shortened, html: html.html, text: text.text }
}

// Whether a body already carries a forwarded block — a caller who passed the
// whole body back, block included, gets it as written rather than twice.
export const carriesForwardBlock = (body: ReplyBody): boolean =>
  Boolean(body.text?.includes(FORWARD_MARKER) || body.html?.includes(FORWARD_MARKER))

const EML_NAME_UNSAFE_RE = /[\\/:*?"<>|\r\n]+/gu

// The whole original as one attachment, by the blobId of its raw message.
export const originalAsAttachment = (original: EmailComposeRecord): DraftAttachment | null => {
  if (!original.blobId) {
    return null
  }
  const name = (original.subject ?? '').replace(EML_NAME_UNSAFE_RE, ' ').trim() || 'forwarded message'
  return { blobId: original.blobId, disposition: 'attachment', name: `${name}.eml`, type: 'message/rfc822' }
}

export interface ForwardDraftInput {
  from: EmailDraft['from']
  // What to do when an original file has no blobId and so cannot be carried:
  // refuse (the one-shot send, where nobody checks the draft first), or attach
  // the whole original as an .eml file (a staged forward the user reviews).
  missingFiles: 'attachOriginal' | 'refuse'
  note: ReplyBody
  original: EmailComposeRecord
  recipients: Pick<EmailDraft, 'bcc' | 'cc' | 'to'>
  subject?: string
}

// The forward as a draft, or why it cannot be built. The original's files are
// carried by blobId; a part without one names nothing that can be carried, and
// forwarding without it would lose a file the user believes went along.
export const forwardDraft = (p: ForwardDraftInput): { error: string } | { draft: EmailDraft; note: string | null } => {
  const missing = (p.original.attachments ?? []).filter((part) => !part.blobId).map((part) => part.name ?? '(unnamed)')
  if (missing.length > 0 && p.missingFiles === 'refuse') {
    return {
      error:
        `${p.original.id} carries a file that cannot be forwarded by reference (${missing.join(', ')}), so ` +
        'it would be left out.',
    }
  }
  const body = forwardedBody(p.note, p.original)
  const whole = body.attachOriginal || missing.length > 0 ? originalAsAttachment(p.original) : null
  const attachments = [...attachmentsFromRecord(p.original), ...(whole ? [whole] : [])]
  const references = forwardReferences(p.original)
  return {
    note: forwardNote(whole !== null, missing),
    draft: {
      from: p.from,
      ...p.recipients,
      subject: p.subject ?? forwardSubject(p.original.subject),
      ...(references.length > 0 ? { references } : {}),
      text: body.text,
      html: body.html,
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  }
}

// The line a result carries when the original went along as a file too.
const forwardNote = (attachedOriginal: boolean, missing: string[]): string | null => {
  if (missing.length > 0) {
    return attachedOriginal
      ? `The original carries a file that cannot be forwarded on its own (${missing.join(', ')}), so the whole ` +
          'message is attached as an .eml file, which includes it.'
      : `The original carries a file that cannot be forwarded on its own (${missing.join(', ')}); it is not in the forward.`
  }
  return attachedOriginal
    ? 'The original was too long to include in full, so it is shortened in the body and the whole message is ' +
        'attached as an .eml file.'
    : null
}
