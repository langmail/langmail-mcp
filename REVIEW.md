# Review instructions

## What Important means here

Reserve Important for findings that would break behavior for an MCP client
or a mailbox: incorrect logic, mail, events or contacts written to or deleted
from the wrong place, a message sent twice or sent when the tool said it was
not, dates or times that land on the wrong day or in the wrong time zone,
credentials or mail content in log lines or error messages, and tool names,
inputs or outputs that change without a breaking-change commit. Style, naming
and refactoring suggestions are Nit at most.

## Name the commit

Start the summary heading with `### ✅ Code review` when you found no
Important findings, or with `### ❌ Code review` when you found any. Name the
head commit you reviewed in that same heading, by at least its first seven
characters.

End the review with `End of review.` on its own line.

## Cap the nits

Nits are optional and do not block a merge. Report at most five Nits per
review. If you found more, say "plus N similar items" in the summary instead
of posting them inline. If you found no Important findings, including when
you found nothing at all, lead the summary with "No blocking issues."

## Do not report

- Anything CI already enforces: Biome lint and formatting, typechecks, tests
- `bun.lock` and `CHANGELOG.md`
- Test-only code that intentionally breaks production rules
- Claims in the PR description, such as "tests pass", as evidence either way

## Always check

- A change to a tool's shape, result or description is checked with an
  agent, not only with unit tests: a trajectory run (`docs/evals.md`) with
  correctness and calls taken before and after, or a stated reason why it was
  not run
- A tool's description still matches what its handler does
- A new tool in `src/tools/` has a `*.test.ts` next to it
- A diff in `src/mcp/tool-surface.test.ts`'s snapshot is a hosted change the
  PR says it means
- Self-hosted code calls no Bun API at runtime, and self-hosted tool texts do
  not name Langmail
- Log lines don't include email addresses, user IDs or message content
- No real people or companies in code, tests, fixtures or docs (`AGENTS.md`)
