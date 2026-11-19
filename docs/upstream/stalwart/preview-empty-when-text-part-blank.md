---
type: upstream
title: Email preview is empty when a multipart/alternative message has a blank text/plain part
description: Stalwart derives an Email's `preview` from the first text body part even when that part is empty, so mail shaped like an Apple Mail draft (empty text/plain, the message in text/html) has no preview and `search_emails` shows no snippet for it; we carry no workaround.
status: open
observed: 1.1.1
owner: dominik
tags: [stalwart, jmap, preview, search]
---

# Email preview is empty when a multipart/alternative message has a blank text/plain part

## Observe

On the dev Stalwart (`stalwartlabs/stalwart:v1.1.1`), two messages were
imported with `Email/import` and read back with `Email/get` for `preview`:

| Message | `preview` |
|---|---|
| `multipart/alternative`: empty `text/plain`, `text/html` holding `<div>Hi Sam,</div><div>the contract is attached, see you Monday.</div>` | `""` |
| `text/html` alone, same markup | `"Hi Sam,the contract is attached, see you Monday."` |

Apple Mail stages drafts in the first shape, so their sent copies carry it too.

## Why it matters

`search_emails` prints Stalwart's `preview` as the snippet
(`normalizedSnippet` in `src/tools/format.ts`). A message of this
shape lists with no snippet, so an agent scanning results cannot tell what
it says without a `get_email` per message.

## Workaround

None. The MCP's own draft tools no longer depend on `preview`: `list_drafts`
and `get_draft` flatten the html part themselves when the text part is
blank (`previewSource` in `src/tools/draft-common.ts`).
Rendering our own snippet for search results would mean fetching body values
for every listed message.

## Upstream

Not reported yet. Searched the support portal ("preview empty
multipart/alternative", "JMAP preview empty html") and GitHub issues
("preview empty", "preview html"): no match.

Root cause: at `v1.1.1`, `crates/email/src/message/metadata/build.rs`
(lines 203-207) stores `message.root().body_preview(PREVIEW_LENGTH)`.
`body_preview` in `mail-parser` 1.0.1 (`src/view/message.rs`, line 635)
takes the first `text_body` part whenever the message has any text part
(`text_len` counts parts, not bytes) and falls back to the html part only
when there is none, so an empty text part wins over a full html part.

The fix to propose: in `body_preview`, skip a text part that is empty or
whitespace-only and preview the html part instead.

## Drop workaround when

There is no workaround to drop. Close this entry when a Stalwart release
returns a non-empty `preview` for a `multipart/alternative` message with an
empty `text/plain` part and a non-empty `text/html` part.
