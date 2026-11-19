---
type: reference
title: Stalwart upstream issues
description: Index of the Stalwart defects and gaps this server carries workarounds for, and how to report one (support portal, not GitHub issues; security findings go privately to security@stalw.art or a private GitHub advisory).
owner: dominik
tags: [stalwart, upstream]
---

# Stalwart upstream issues

Format and lifecycle: [`docs/upstream/AGENTS.md`](../AGENTS.md). Before
reading Stalwart source, switch to the release the tests run against:
[Read the source of the release we run](../AGENTS.md#read-the-source-of-the-release-we-run).

## Reporting

`stalwartlabs/stalwart` auto-closes direct GitHub issue submissions and routes
triage through the support portal at <https://support.stalw.art> (sign in
with GitHub). A maintainer files the actual GitHub issue from there. An entry
may therefore link to a closed GitHub issue as the paper trail while the live
report sits in the portal until the maintainer reopens or re-creates it.

Search the portal for the symptom before investigating (see
[Check for a known defect first](../AGENTS.md#check-for-a-known-defect-first)).
It is a Discourse forum, and its JSON search works without signing in:
`curl -sG https://support.stalw.art/search.json --data-urlencode "q=<terms>"`
returns `topics[]` with `id` and `title`, and `https://support.stalw.art/t/<id>.json`
returns the thread, where `staff: true` marks maintainer posts. The endpoint
answers `429` after about five searches in quick succession, so pick the
phrasings carefully. Python's `urllib` gets `403`; use `curl`. Directly
submitted GitHub issues are auto-closed but stay searchable
(`gh search issues --repo stalwartlabs/stalwart`), so check both.

Security-relevant findings (access control, injection, disclosure) do **not**
go to the public portal. Upstream's `SECURITY.md` and
<https://stalw.art/.well-known/security.txt> route them to
`security@stalw.art` or a private GitHub security advisory. The same policy
says upstream ignores reports it judges LLM-generated: a security report must
come from a person who reproduced the finding on a running, supported release.
An unconfirmed source read stays in the entry, marked as such, until then.

### The portal's issue form

The portal asks for these fields, in this order. Free-text unless marked as a
dropdown. The form opens by telling you that "most reported issues turn out to
be configuration problems rather than actual bugs" and asking you to check the
docs, FAQ and existing topics first — which is what an entry in this folder is
for: it should already carry the reproduction and the source pointers that
show the behaviour is upstream's, not ours.

| Field | What it wants |
|---|---|
| **Issue Description** | The symptom, with relevant context — configuration, environment, recent changes that might have led to it. |
| **Expected Behavior** | How Stalwart should behave, with documentation links where they exist. |
| **Actual Behavior** | How it behaves instead. If the deviation is not obvious from the two side by side, name it explicitly. |
| **Reproduction Steps** | Numbered, step by step. |
| **Relevant Log Output** | Inside triple backticks. Set the logging level to `trace` if nothing useful appears at the default level. |
| **Stalwart Version** | dropdown |
| **Installation Method** | dropdown |
| **Database Backend** | dropdown — the data store |
| **Blob Storage** | dropdown |
| **Search Engine** | dropdown |
| **Directory Backend** | dropdown — where the user database lives |
| **Additional Context** | Client software and versions, proxy/reverse-proxy config, network setup (NAT, firewall). |

## Verification

Each entry's `observed` frontmatter is the version its finding was
established on. Until the move to this repository, the entries were
re-checked against every Stalwart release through 1.1.1 in
`langmail/platform`. Re-check them here on every bump of
`infra/dev/stalwart/version.json`, and add a row:

| Re-checked through | Date | Result |
|---|---|---|

## Entries

| File | Status | Observed | Workaround |
|---|---|---|---|
| [caldav-resource-name-encoding-asymmetric](caldav-resource-name-encoding-asymmetric.md) | open | 0.16.22 | `.ics` resources named as a bare UUID (`newEventResourceName`), so no name needs encoding; resolution half fixed in 1.0.0 |
| [contact-query-cannot-match-titles](contact-query-cannot-match-titles.md) | open | 1.1.0 | `search_contacts` pages the whole book and matches roles itself (`sweepBook`) |
| [itip-ingest-picks-first-uid-match](itip-ingest-picks-first-uid-match.md) | open | 0.16.23 | None; a proposed `move_calendar_events` (draft) would refuse the duplicate and report it as `ambiguous` |
| [itip-invite-after-update-drops-override](itip-invite-after-update-drops-override.md) | filed | 1.0.0 | The mcp control test waits for the invite before the organizer moves an instance; production: none. Fixed in source at 1.0.2, live replay pending |
| [preview-empty-when-text-part-blank](preview-empty-when-text-part-blank.md) | open | 1.1.1 | None; `list_drafts` and `get_draft` flatten the html part themselves, `search_emails` shows no snippet |
| [vcard3-email-pref-is-vcard4-syntax](vcard3-email-pref-is-vcard4-syntax.md) | open | 1.0.2 | None; Langmail reads the preferred address over JMAP, so only 3.0-only CardDAV clients miss it |
