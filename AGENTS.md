# services/mcp — operational notes

MCP resource server. Runs on the `app` VM, fronted by nginx for TLS +
ACME; talks to Stalwart over public HTTPS for OAuth + JMAP.

This README captures per-service conventions. Repo-wide guidance lives
in `../../AGENTS.md`; the design rationale lives in
`../../spec/03-monorepo-and-app-vm.md` and `../../spec/02-mcp.md`.

## Runtime: Bun only, no Node fallback

This service is **Bun-only**. The compiled artifact (`dist/mcp`,
produced by `bun build --compile`) embeds the Bun runtime; the target
VM does not install Node and never will.

- `bun install` — installs into `node_modules/`; writes `bun.lock`.
- `bun run dev` — local dev server on `127.0.0.1:8080`.
- `bun run build` — produces `dist/mcp`, a standalone x86_64-linux
  binary (target = `bun-linux-x64`, ~50–100 MB).
- `bun run typecheck` — typecheck only.

Do not add a `node` or `npm` script anywhere. If a dependency is
node-only and won't run under Bun, find another or write the call
inline.

## Build + deploy: rsync, not Nix-built

We chose the spec's **rsync fallback** (`spec/03 §Phase 3 step 4`) over
the FOD-`bun install`-into-Nix path. Rationale:

- nixpkgs has no first-class `buildBunModule`; `fetchNpmDeps` only
  speaks `package-lock.json`.
- Bun's installer is not deterministic enough to trust as the FOD
  fetch phase without a non-trivial babysitting layer.
- The artifact is a single static binary, so the "ship TS in the
  closure" problem reduces to "rsync one file." Closure stays infra-
  only; nothing TS leaks into Nix evaluation.

Pipeline (driven by `just deploy-app`):

1. `just build-mcp` — `bun install --frozen-lockfile && bun run build`
   in this directory. Produces `services/mcp/dist/mcp`.
2. `just push-mcp` — rsync the binary to
   `/var/lib/mcp/bin/mcp` on the app VM.
3. `just rebuild-app` — `nixos-rebuild switch` picks up any module
   changes; `infra/modules/mcp.nix` declares the systemd unit that
   ExecStarts `/var/lib/mcp/bin/mcp`.
4. `systemctl restart mcp` (folded into `push-mcp`).

Reconsider Nix-builds-Bun once nixpkgs ships `buildBunModule` or once
a second TS consumer makes the rsync path painful.

## Adding tools (preview of phase 4)

When `spec/02-mcp.md` lands, the `/mcp` route in `src/index.ts` will
mount `StreamableHTTPServerTransport` and register tools. Conventions:

- One file per tool under `src/tools/`. Default-export a registration
  function that takes the `McpServer` and adds the tool.
- JMAP wire shape lives in `src/jmap/` as ~200 lines of typed `fetch`
  wrappers (`Email/query`, `Email/get`, ...). Extract to
  `packages/jmap-client/` only when a second service needs it — at
  which point a Bun workspace at the repo root lands too.
- Auth principal comes from `GET /auth/userinfo` against Stalwart with
  the client's bearer; cache `(token, principal)` until token `exp`.
  See `../../spec/03-monorepo-and-app-vm.md §MCP RS auth model` for
  why we don't gate on `aud` or `scope`.

## Configuration

Environment variables (set via `infra/modules/mcp.nix`
`EnvironmentFile=/run/secrets/mcp.env`):

| Var                   | Default                    | Notes                                               |
| --------------------- | -------------------------- | --------------------------------------------------- |
| `MCP_HOST`            | `127.0.0.1`                | bind address — keep loopback in prod (nginx fronts) |
| `MCP_PORT`            | `8080`                     | upstream port nginx proxies to                      |
| `MCP_PUBLIC_URL`      | `http://127.0.0.1:8080`    | full base URL, e.g. `https://mcp.langmail.me`       |
| `STALWART_PUBLIC_URL` | `https://mail.langmail.me` | issuer for OAuth metadata                           |

The `EnvironmentFile` may be empty on a fresh VM — defaults boot a
usable server, just with the wrong public URL.
