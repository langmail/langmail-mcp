---
type: upstream
title: Stalwart writes an email's preference as vCard 4.0 PREF=1 inside a vCard 3.0 card
description: Stalwart 1.0.2 serves the JSContact `pref` on an email address as `EMAIL;PREF=1` in a `VERSION:3.0` card. `PREF` is a vCard 4.0 parameter; vCard 3.0 marks the preferred address with `TYPE=pref`. A 3.0-only client, which is what production serves to iPhone Contacts, may not show which address merge_contacts or update_contact marked as preferred. Langmail's own ranking reads the mark over JMAP and is unaffected. Workaround: none.
status: open
observed: 1.0.2
owner: dominik
tags: [stalwart, carddav, vcard, contacts]
---

# Stalwart writes an email's preference as vCard 4.0 PREF=1 inside a vCard 3.0 card

## Observe

Checked on the dev Stalwart (1.0.2, `infra/dev/stalwart/docker-compose.yml`)
on 2026-11-07, while building `merge_contacts`:

1. A card was created over JMAP with two email entries, one carrying
   `pref: 1`.
2. It was read back over CardDAV with an `addressbook-query` `REPORT` that
   asked for `address-data` and sent no version.

The server answered:

```text
BEGIN:VCARD
VERSION:3.0
EMAIL:a@example.com
EMAIL;PREF=1:b@example.com
FN:Pref Check
UID:pref-check-1
END:VCARD
```

`PREF` is the vCard 4.0 preference parameter (RFC 6350 §5.3). vCard 3.0 has
no `PREF` parameter and marks the preferred address with `TYPE=pref`
(RFC 2426 §3.3.2). The JMAP round trip of `pref: 1` is correct; only the 3.0
rendering is off.

## Why it matters

`merge_contacts` and `update_contact` (`preferredEmail`) store which address
mail to a contact should go to as `pref: 1`
(`withPreferredEmail` in `src/contacts/merge.ts`). Production serves
vCard 3.0 to every client that asks for no version, and iPhone Contacts never
asks (`docs/reference/stalwart/observed-behaviour.md` in langmail/platform). If such a client
ignores the 4.0 parameter, the phone shows no preferred address, or it picks its own,
while Langmail's agents use the marked one. Mail an agent drafts and mail the
user starts from the phone can then go to different addresses of the same
contact.

Not checked: whether iOS Contacts reads `PREF=1` in a 3.0 card anyway, and
whether it keeps the parameter when it writes the card back.

## Workaround

None. Langmail's ranking (`bestAddress` in `src/contacts/scoring.ts`)
reads `pref` over JMAP and is unaffected.

## Upstream

Not filed yet. The Stalwart support portal signs in with GitHub and needs the
maintainer's account. The fix to propose: when writing vCard 3.0, render a
`pref` of 1 as `TYPE=pref` on `EMAIL` (and on `TEL` and `ADR`), and read
`TYPE=pref` back as `pref: 1`.

## Drop workaround when

There is no workaround to drop. Delete this file when, on the release being
adopted, a card with `pref: 1` on an email reads back over CardDAV with no
`Accept` version as `EMAIL;TYPE=pref:…` (or another 3.0 form a 3.0 client
reads), and a 3.0 upload of `TYPE=pref` reads back over JMAP as `pref: 1`.
