# Agent evals

The `smoke-agent-*.ts` scripts in `scripts/` drive `claude -p` against the
MCP server and check the tool calls it makes, not only its answer. Each run
seeds real messages into the mailbox it uses, removes them on exit and ends
with `result: pass|fail|error · tool calls: N`. `error` is a crash, not a
verdict, and N counts `mcp__langmail__*` calls only. A run costs model tokens
and is not deterministic, so compare a few runs before and after a change.

You need the `claude` CLI on `PATH` and a Stalwart account that can be filled
with test mail. The dev Stalwart in `infra/dev/stalwart` works: start it with
`docker compose -f infra/dev/stalwart/docker-compose.yml up -d`, then create a
throwaway user with an app password in its admin at `http://127.0.0.1:9090` (`admin` / `devpassword`).

Start the self-hosted server over HTTP in one shell:

```sh
STALWART_URL=http://127.0.0.1:9090 STALWART_USERNAME=<user> STALWART_PASSWORD=<app password> \
  MCP_AUTH_TOKEN=eval-secret bun run start:self-hosted --transport http --port 8095
```

Run an eval in another:

```sh
AGENT_EVAL_MCP_URL=http://127.0.0.1:8095/mcp AGENT_EVAL_MCP_TOKEN=eval-secret \
  AGENT_EVAL_STALWART_USERNAME=<user> AGENT_EVAL_STALWART_PASSWORD=<app password> \
  STALWART_PUBLIC_URL=http://127.0.0.1:9090 bun run smoke:agent-self-hosted
```

With `AGENT_EVAL_MCP_URL` set, the agent gets only that server
(`--strict-mcp-config`), and the URL must be local, as must
`STALWART_PUBLIC_URL`. Leave `MCP_ACCESS_TOKEN` unset: it switches the library
to a Langmail account on the hosted server. To compare a branch with `main`,
start `main`'s server from a second worktree on another port and run the same
eval against each, one after the other, since both use the same mailbox.

Which evals run here and which need the hosted server: `docs/self-hosted.md`
§ Agent evals.
