# Review instructions

## What Important means here

Reserve Important for findings that would break behavior for an MCP
client or for a mailbox, calendar or address book:

- incorrect logic: mail sent, moved or deleted wrongly, or data written
  to or deleted from the wrong message, event or contact
- dates or times that land on the wrong day or in the wrong time zone
- tool names, inputs, outputs or descriptions that drift from the hosted
  reference (<https://docs.langmail.me/reference/mcp/overview>)
- new outbound traffic to anything but the user's Stalwart that is not
  behind an opt-in flag that defaults to off
- a Langmail host or service as a default anywhere
- secrets, real people or real hosts in test data (it must use
  `example.com`)

Style, naming, and refactoring suggestions are Nit at most.

## Name the commit

Start the summary heading with `### Code review` and name the head commit
you reviewed in that same heading, by at least its first seven characters.

End the review with `End of review.` on its own line. The workflow fails
the run if this line is missing.

## Cap the nits

Report at most five Nits per review. If you found more, say "plus N
similar items" in the summary instead of posting them inline. If you
found no Important findings, including when you found nothing at all,
lead the summary with "No blocking issues."

## Do not report

- Anything CI already enforces: Biome lint and formatting, typechecks,
  tests and knip
- `package-lock.json` and `CHANGELOG.md`
- Claims in the PR description, such as "tests pass", as evidence either way

## Always check

- A tool's description still matches what its handler does
- A new tool in `src/tools/` has a `*.test.ts` next to it
- The behaviour of every kept tool is still covered in `e2e/`
- Whole-day and time zone handling
