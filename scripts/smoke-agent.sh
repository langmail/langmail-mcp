#!/usr/bin/env bash
# Phase 3b — agent-ergonomics smoke. Drives the deployed langmail MCP
# server through `claude -p` with a natural-language prompt and a
# JSON-schema-constrained response. Asserts:
#
#   - the LLM discovers `search_emails` from descriptions alone (we
#     phrase the prompt as a user task, not a "call the tool" command),
#   - the response shape matches the schema (tools[]: name/ok/...
#     + bad_input_test: { graceful_error }),
#   - all exercised tools report ok=true AND bad_input_test.graceful_error
#     is true.
#
# Complements scripts/smoke.ts (deterministic protocol-level). This
# script catches what schema checks can't — vague descriptions,
# confusing parameter names, unhelpful error messages.
#
# Slow + non-deterministic; runs only via `just smoke-test-mcp-agent`.
# Not part of `just deploy`.
#
# Requires:
#   - `claude` CLI on PATH
#   - MCP_ACCESS_TOKEN exported (typically via
#     `source <(./infra/scripts/obtain-mcp-tokens.sh)`)
#   - `.mcp.json` at the repo root (this script cd's there)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

command -v claude >/dev/null 2>&1 || {
  echo "claude CLI not found on PATH" >&2; exit 1; }
[[ -n "${MCP_ACCESS_TOKEN:-}" ]] || {
  echo "MCP_ACCESS_TOKEN not set — source <(./infra/scripts/obtain-mcp-tokens.sh) first" >&2
  exit 1; }
[[ -f .mcp.json ]] || { echo ".mcp.json missing at $REPO_ROOT" >&2; exit 1; }

# Where the agent is told to save the attachment — created fresh per run so
# the size/magic verification below can't match a stale file.
SAVE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/langmail-agent-smoke.XXXXXX")"

PROMPT=$(cat <<EOF
I run a smoke test that self-delivers a tagged message to my own
mailbox on every deploy — subjects look like \`smoke-<unix-ts>-<pid>\`,
e.g. \`smoke-1779448978-1390\`. There should be at least one such
message sitting in my Inbox right now. Find it and tell me:

  - the exact subject of the most recent one,
  - who it's from,
  - roughly when it arrived.

If you genuinely can't find any smoke-tagged message, say so and
don't invent one — but I'd be surprised: there should be at least
one. Report subject_found verbatim so I can verify it matches what
my deploy script logged.

That message carries a PDF attachment (an invoice-style smoke file).
This is the accounting task I actually care about: save that PDF into
the directory ${SAVE_DIR} on this machine, then report which tool you
used to get it, the absolute path you saved it to, and the file size
in bytes as it ended up on disk. Do not paste the file's content into
the conversation.

One last thing: as a sanity check, deliberately call the search with
a clearly nonsense limit like 9999 and tell me whether the server
responded with a clean error or blew up.

Report back as JSON matching the provided schema, with one entry per
tool you actually called. Set ok=false for any tool that errored
unexpectedly. The bad_input_test section should describe the
limit=9999 attempt.
EOF
)

SCHEMA='{
  "type": "object",
  "properties": {
    "tools": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {"type": "string"},
          "ok": {"type": "boolean"},
          "response_summary": {"type": "string"},
          "error": {"type": ["string", "null"]}
        },
        "required": ["name", "ok"]
      }
    },
    "find_smoke_message": {
      "type": "object",
      "properties": {
        "found": {"type": "boolean"},
        "subject_found": {"type": ["string", "null"]},
        "from_found": {"type": ["string", "null"]}
      },
      "required": ["found"]
    },
    "save_attachment": {
      "type": "object",
      "properties": {
        "tool_used": {"type": "string"},
        "saved_path": {"type": ["string", "null"]},
        "file_size_bytes": {"type": ["number", "null"]}
      },
      "required": ["tool_used", "saved_path", "file_size_bytes"]
    },
    "bad_input_test": {
      "type": "object",
      "properties": {
        "tool": {"type": "string"},
        "graceful_error": {"type": "boolean"},
        "error_message": {"type": "string"}
      },
      "required": ["tool", "graceful_error"]
    }
  },
  "required": ["tools", "find_smoke_message", "save_attachment", "bad_input_test"]
}'

# Bash(curl:*) lets the agent save the capability URL to disk — the
# download_attachment contract is bytes-out-of-band, never through context.
result=$(claude -p "$PROMPT" \
  --mcp-config .mcp.json \
  --allowedTools "mcp__langmail__*,Bash(curl:*)" \
  --output-format json \
  --json-schema "$SCHEMA")

echo "$result" | jq '.structured_output'

pass_tools=$(echo "$result" | jq -e '.structured_output.tools | length > 0 and all(.ok == true)' >/dev/null && echo yes || echo no)
pass_bad=$(echo  "$result" | jq -e '.structured_output.bad_input_test.graceful_error == true' >/dev/null && echo yes || echo no)
# Real find: the LLM must report a smoke-tagged subject AND identify
# smoketest@langmail.me as the sender. Anything else means it either
# didn't find the planted message, or hallucinated one.
pass_find=$(echo "$result" | jq -e '
  .structured_output.find_smoke_message
  | (.found == true)
    and ((.subject_found // "") | test("^smoke-[0-9]+-[0-9]+"))
    and ((.from_found    // "") | test("smoketest@"))
' >/dev/null && echo yes || echo no)

# The accounting task: the LLM must have chained to download_attachment from
# the descriptions alone, and the file it reports must really be on disk with
# the reported size and a PDF magic — bytes to disk, not into context.
pass_save=no
saved_path=$(echo "$result" | jq -r '.structured_output.save_attachment.saved_path // ""')
reported_size=$(echo "$result" | jq -r '.structured_output.save_attachment.file_size_bytes // 0')
tool_used=$(echo "$result" | jq -r '.structured_output.save_attachment.tool_used // ""')
if [[ "$tool_used" == "download_attachment" && -f "$saved_path" ]]; then
  actual_size=$(wc -c < "$saved_path" | tr -d ' ')
  if [[ "$actual_size" == "$reported_size" ]] && head -c 5 "$saved_path" | grep -q '%PDF'; then
    pass_save=yes
  fi
fi

# No base64 blob anywhere in the response — the transcript-level check that
# the agent curled the URL instead of reading the bytes into context.
pass_hygiene=$(echo "$result" | grep -qE '[A-Za-z0-9+/=]{300,}' && echo no || echo yes)

if [[ "$pass_tools" == "yes" && "$pass_bad" == "yes" && "$pass_find" == "yes" \
      && "$pass_save" == "yes" && "$pass_hygiene" == "yes" ]]; then
  echo "✅ agent smoke passed"
else
  echo "❌ agent smoke failed (tools=$pass_tools bad_input=$pass_bad find=$pass_find save=$pass_save hygiene=$pass_hygiene)" >&2
  exit 1
fi
