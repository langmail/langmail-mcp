---
type: upstream
title: Stalwart's ContactCard/query cannot find a card by its title or role
description: On Stalwart 1.1.0 the `text` condition of ContactCard/query does not search a card's `titles` (vCard `TITLE` / `ROLE`), and a `title` condition is rejected as `unsupportedFilter`. search_contacts finds people by the role the user gave them ("my lawyer"), so it pages the whole book and matches `titles` itself. Workaround in `src/tools/search-contacts.ts` (`sweepBook`).
status: open
observed: 1.1.0
owner: dominik
tags: [stalwart, jmap, contacts, search]
---

# Stalwart's ContactCard/query cannot find a card by its title or role

## Observe

Checked on the dev Stalwart (1.1.0, `infra/dev/stalwart/docker-compose.yml`)
on 2026-11-12, while building contact roles
(<https://github.com/langmail/platform/issues/1213>):

1. Two cards were created over JMAP, one with
   `titles: { r0: { name: "lawyer", kind: "role" } }` and an email, one with
   `titles: { r0: { name: "landlord", kind: "role" } }` and no email.
2. After the index had caught up (a `text` query on the first card's name
   found it), `ContactCard/query` was called with each filter:

| Filter | Result |
|---|---|
| `{ "text": "Fairweather" }` (the name) | the card |
| `{ "text": "lawyer" }` | `ids: []` |
| `{ "text": "landlord" }` | `ids: []` |
| `{ "name": "lawyer" }` | `ids: []` |
| `{ "title": "lawyer" }` | `error`, `unsupportedFilter`, `"title"` |

`ContactCard/get` returns the `titles` unchanged, and over CardDAV the cards
carry `ROLE;PROP-ID=r0:lawyer`, so the data is stored and served; only the
query cannot reach it.

Not checked: whether RFC 9610 lists `titles` among the properties the `text`
condition searches (the RFC was not reachable from the session that found
this). If it does not, this is a missing feature rather than a defect, and
the entry belongs under `docs/reference/stalwart/` in langmail/platform instead.

## Why it matters

`search_contacts` finds a person by what they are to the user
(`readRoles` in `src/contacts/profile.ts`). A filtered query cannot
match a role, as above, so without a workaround a contact whose role is
`lawyer` would be found by "my lawyer" only if some other read happened to
return the card, and the agent would fall back to a mail search.

## Workaround

`sweepBook` in `src/tools/search-contacts.ts`: every search
pages the whole book with no filter, 500 cards per request (an unfiltered
`ContactCard/query` and a `ContactCard/get` of `id`, `name`,
`organizations`, `emails` and `titles` through a `#ids` back-reference, up
to 50 000 cards), and matches names, organizations, addresses and roles
itself. The live test in
`src/tools/search-contacts-stalwart.test.ts` (cards past
position 300) covers it.

## Upstream

Not reported yet. The fix to propose: include `titles[*].name` in the
`text` condition's index, or accept a `title` filter condition next to
`name`, `email` and `organization`.

## Drop workaround when

A Stalwart release answers `ContactCard/query` `{ "text": "lawyer" }` with
the card whose only "lawyer" is a title. The live test in
`src/tools/search-contacts-stalwart.test.ts` (cards past
position 300) asserts that a title-only word is not found and turns red on
that release. The sweep still has other reasons (ranking every match, no
index lag), so then only this entry closes; a later change that goes back
to a filtered query may rely on the condition.
