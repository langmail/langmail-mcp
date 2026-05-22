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

PROMPT=$(cat <<'EOF'
I'm trying to find a specific message in my mailbox — recently I had
some smoke-test traffic land there and I'd like to confirm at least
one such message is sitting in the Inbox. Could you look it up and
tell me the subject, sender, and roughly when it arrived? If nothing
turns up, just say so — don't invent results.

One last thing: as a sanity check, deliberately call the search with
a clearly nonsense limit like 9999 and tell me whether the server
responded with a clean error or blew up.

Report back as JSON matching the provided schema, with one entry per
tool you actually called. Set ok=false for any tool that errored
unexpectedly, and include the raw error string. The bad_input_test
section should describe the limit=9999 attempt.
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
  "required": ["tools", "bad_input_test"]
}'

result=$(claude -p "$PROMPT" \
  --mcp-config .mcp.json \
  --allowedTools "mcp__langmail__*" \
  --output-format json \
  --json-schema "$SCHEMA")

echo "$result" | jq '.structured_output'

pass_tools=$(echo "$result" | jq -e '.structured_output.tools | length > 0 and all(.ok == true)' >/dev/null && echo yes || echo no)
pass_bad=$(echo "$result"   | jq -e '.structured_output.bad_input_test.graceful_error == true' >/dev/null && echo yes || echo no)

if [[ "$pass_tools" == "yes" && "$pass_bad" == "yes" ]]; then
  echo "✅ agent smoke passed"
else
  echo "❌ agent smoke failed (tools=$pass_tools bad_input=$pass_bad)" >&2
  exit 1
fi
