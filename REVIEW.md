# Review instructions

What matters in this repository. The review format, and what no review
reports, are in the prompt of langmail/factory's `review.yml`.

## What Important means here

Reserve Important for findings that would break behavior for an MCP client
or a mailbox: incorrect logic, mail, events or contacts written to or deleted
from the wrong place, a message sent twice or sent when the tool said it was
not, dates or times that land on the wrong day or in the wrong time zone,
credentials or mail content in log lines or error messages, and tool names,
inputs or outputs that change without a breaking-change commit.

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
