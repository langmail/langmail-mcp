---
type: reference
title: Upstream issues
description: How defects and gaps in the third-party software we depend on are recorded — one folder per dependency, one file per issue, each with a workaround and a "drop workaround when" clause, and which release to read upstream source at (the one we run, not whatever a local clone is on). Read this before documenting an upstream bug anywhere else, or before reading a dependency's source.
owner: dominik
tags: [docs, conventions, upstream, agents]
---

# Upstream issues

This folder is the registry of defects, missing features and undocumented
limitations in the software we depend on but do not own (Stalwart, @date-fns/tz,
timezones-ical-library and whatever comes next) that have shaped a design decision or a workaround
in this repository.

It exists so that the workaround and the reason for it are never separated.
A workaround whose reason is lost cannot be removed safely; a reason recorded
only in a chat log, a commit message or someone's memory is lost the moment
that context is gone.

## Check for a known defect first

When a symptom points at a dependency, check whether it is already known
**before** reading upstream source or building a reproduction:

1. **This folder.** Grep `docs/upstream/<dependency>/` for the symptom. An
   entry may already hold the root cause, the workaround and the report link.
2. **Upstream's tracker.** The dependency's `AGENTS.md` names its filing
   channel (for Stalwart, the support portal, not GitHub issues). Search it for
   the symptom in a few phrasings, open and closed. Someone else's report
   often carries a maintainer answer: fixed in an unreleased branch, won't
   fix, or a workaround.

An existing report changes the work. Open it in the user's browser right away
(`open <url>` on macOS) so they can read the thread themselves. Link it from
the entry, set `status: filed`, and add our evidence to that thread instead of
filing a duplicate.
Only when both searches come up empty is it a new investigation.

## Read the source of the release we run

A claim about upstream code holds only for the version it was read at.
Before reading a dependency's source, find the version the tests run against
and read that tag, not whatever a checkout happens to be on. For Stalwart,
that is `stalwart` in `infra/dev/stalwart/version.json`; for an npm
dependency, the version in `bun.lock`. On a bump, read both the old and the
new tag and re-stamp pointers to the new one.

A clone next to this repository, such as `../stalwart`, is a cache that may
be on an old release. Update it and switch to the tag before you read, from
the repository root:

```sh
git -C ../stalwart fetch --tags
git -C ../stalwart switch --detach "v$(jq -r .stalwart infra/dev/stalwart/version.json)"
```

Without a clone, fetch the files at that tag from GitHub, never from the
default branch. Pin every source pointer you write down to that tag.

## What belongs here

An entry is warranted when all of the following hold:

- The behaviour is upstream's, not ours: it reproduces against an unmodified
  release and no configuration of ours changes it.
- It is a **defect or gap** — something upstream would plausibly accept as a
  bug report or a feature request. Behaviour that is merely surprising but
  permitted (an RFC "MAY" upstream chose not to implement, a default we did
  not expect) is *reference* material and goes in a comment at the code it shapes,
  because it will never have a drop clause.
- We carry something because of it: a workaround in code or config, a design
  decision, an operational rule, or an explicit "no mitigation possible".

What does **not** belong here:

- Bugs in our own code, even when the symptom appeared in an upstream
  component. Those are fixed and closed in git.
- Investigations of planned work. A GitHub issue or a research doc may
  *discover* an upstream defect; the defect then gets its own file here and
  the issue links to it. **No issue carries an upstream defect's description
  inline**: the issue closes on ship, and the upstream file outlives it.

## Layout

```text
docs/upstream/
  AGENTS.md                         # this file
  <dependency>/
    AGENTS.md                       # filing channel, verification ledger, index
    <symptom-in-kebab-case>.md      # one issue per file
    <symptom-in-kebab-case>.patch   # optional: a source patch, next to its doc
```

The **file path is the issue's identity.** Code, runbooks and other docs refer
to an issue by its path (`docs/upstream/stalwart/contact-query-cannot-match-titles.md`),
never by a number: paths are greppable, clickable and survive reordering.

## Entry format

Frontmatter first:

```yaml
---
type: upstream
title: One line naming the symptom, not the root cause
description: What is broken, why it matters to us, and what we do about it — an agent reads only this line to decide relevance
status: open | filed | fixed-upstream
observed: 0.16.11          # the upstream version the finding was established on
fixed-in: 0.16.21          # only with status: fixed-upstream — the first release carrying the fix
owner: dominik
tags: [stalwart, calendar, imip]
---
```

`status` follows the issue's lifecycle, and each value implies an action:

| Status | Meaning | Next action |
|---|---|---|
| `open` | Confirmed against upstream; not reported yet | Report it through the dependency's filing channel — or state under **Upstream** why not (design limitation, already tracked elsewhere) |
| `filed` | Reported; a link to the report is in the doc | Watch for a fix in each release |
| `fixed-upstream` | A release ≥ X contains the fix; we have not adopted it yet | On the next bump to ≥ X: remove the workaround **and this file** in the same commit |

`observed` pins the finding to the version it was verified on. Claims about
upstream code rot silently; the version tells the reader how much to trust
the claim and the dependency's `AGENTS.md` ledger records how far the
re-checks have reached since.

Body sections, in this order. Keep the headings verbatim so the file stays
skimmable and the drop clause is always where the upgrade process expects it:

1. **Observe** — what happens, with the version and the evidence (log lines,
   wire captures, source pointers pinned to a tag or commit).
2. **Why it matters** — the consequence for us. What breaks, for whom, how
   visibly.
3. **Workaround** — what this repository does about it, with paths. "None"
   is a valid answer and worth stating.
4. **Upstream** — where it is tracked (or why it is not), the root cause in
   upstream's code if known, and the fix we would propose.
5. **Drop workaround when** — the observable condition that makes the
   workaround unnecessary. Written so that someone reading a release
   changelog can tell whether it is satisfied.

Optional, placed where they read best: **Root cause** (when it deserves
more than a sentence under Upstream) and **What is not the cause** —
hypotheses tested and ruled out, so the next investigation does not repeat
them.

## Linking the three artifacts

Every issue has up to three artifacts, and each must point at the others:

- **The doc** (here) links to the workaround's code path and to the upstream
  report.
- **The workaround in code** carries a comment naming the doc by path
  (`// see docs/upstream/stalwart/<file>.md`). This is the link an agent
  editing that code will actually see; the comment is what stops a
  well-meaning cleanup from deleting a deliberate workaround.
- **A test that exercises the upstream defect directly**, where one is
  practical, so that an upstream fix turns a passing suite red and announces
  that the workaround can go. Note it in the doc's "Drop workaround when".

## Lifecycle

- **Created** when the defect is confirmed against an unmodified upstream
  release — not on suspicion. Once the new file is written, open it in the
  user's default Markdown editor (`open <path>` on macOS) so they can read it
  right away. Skip this when there is no desktop session, as in CI.
- **Re-checked** on every dependency bump: the upgrade skill for the
  dependency walks each file's drop clause against the release notes and
  re-stamps the ledger in the dependency's `AGENTS.md`.
- **Deleted**, together with the workaround, in the commit that adopts the
  fixing release. Git is the archive; a retired issue left in the tree reads
  as still broken and misleads the next reader. The retirement gets one row in
  the dependency's ledger and the commit message — never a "Retired on …"
  paragraph in the dependency's `AGENTS.md`, which every session working
  there pays for.

The same lifecycle applies when *our* architecture changes so that the
workaround no longer exists: delete the file and name it in the commit.
