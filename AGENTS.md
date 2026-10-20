# services/mcp — operational notes

MCP resource server. Runs on the `app` VM, fronted by nginx for TLS +
ACME; authenticates clients against Better Auth (OAuth/OIDC) and talks to
Stalwart over public HTTPS for JMAP + CalDAV.

The public endpoint is `https://mcp.langmail.me/mcp` (Streamable HTTP).
Repo-wide guidance lives in `../../AGENTS.md`; the identity design in
`../../docs/decisions/0003-better-auth-as-openid-provider.md`.

## Stalwart upstream issues
CalDAV/iMIP defects this service works around → `docs/upstream/stalwart/`
(scheduling behaviour that is by design → `docs/reference/stalwart/observed-behaviour.md`).
Read the matching issue file before changing a workaround; each has a
"Drop workaround when" clause.

## Runtime: Bun only, no Node fallback

This service is **Bun-only**. It ships as a container image (`oven/bun`
base) that runs the TypeScript from source; the target VM does not
install Node and never will.

- `bun install` — installs into `node_modules/`; writes `bun.lock`.
- `bun run dev` — local dev server on `127.0.0.1:8080`.
- `bun run build` — `tsc --noEmit` type check (the turbo "build" gate;
  the container runs from source, so there is no compile/bundle step).
- `bun run start` — production entrypoint (`NODE_ENV=production bun
  src/index.ts`), what the container's `CMD` runs.
- `bun run typecheck` — typecheck only.
- `bun run spec:check` — TLC run of the send-protocol model; see
  `spec/AGENTS.md` before touching `sendDraft` or `replyToMessage`.

Point a local client at the dev server with
`claude mcp add --transport http langmail-local http://127.0.0.1:8080/mcp`.

### CalDAV integration tests

`bun test` runs the unit suite. `bun run test:integration` drives the real
CalDAV adapter against a live server and skips unless `CALDAV_BASE_URL` /
`CALDAV_USERNAME` / `CALDAV_PASSWORD` are set. CI runs it against a throwaway
Radicale (`.github/workflows/test-caldav.yml`); locally:

```bash
pip install radicale
printf 'test:test\n' > /tmp/radicale-users
radicale --auth-type htpasswd --auth-htpasswd-filename /tmp/radicale-users \
  --auth-htpasswd-encryption plain --storage-filesystem-folder /tmp/radicale &
CALDAV_BASE_URL=http://127.0.0.1:5232 CALDAV_USERNAME=test CALDAV_PASSWORD=test \
  bun run test:integration
```

Do not add a `node` or `npm` script anywhere. If a dependency is
node-only and won't run under Bun, find another or write the call
inline.

## Build + deploy: container image, pinned by digest

The artifact is a container image, not a Nix-built package — nixpkgs
has no first-class `buildBunModule`, and a container is the
language-agnostic unit shared with the deprecated stack. Pipeline:

1. Push to `main` → `.github/workflows/deploy-mcp.yml` tests, builds
   `services/mcp/Dockerfile`, pushes `ghcr.io/langmail/platform-mcp`,
   and commits the new `@sha256` digest into `infra/modules/mcp.nix`.
2. `just rebuild-app` — NixOS pulls the pinned image and (re)starts the
   `podman-mcp` container behind nginx. A fresh VM can't pull the
   placeholder digest until the first image build — expected.

See `infra/AGENTS.md § app-VM services run as digest-pinned
containers`. (Reconsider Nix-building Bun if nixpkgs ever ships
`buildBunModule`.)

## Adding tools

Load the `mcp-tool-design` skill before adding or changing a tool.

- One file per tool under `src/tools/`, exporting a `register<Tool>`
  function that `src/mcp/handler.ts` calls with the `McpServer`.
- The public tool reference is `apps/docs/reference/mcp/<tool>.mdx`; update
  it in the same PR that changes a tool's behaviour or schema.
- JMAP wire shape lives in the shared `@langmail/jmap` package (typed
  `fetch` wrappers: `Email/query`, `Email/get`, `Email/set`,
  `Email/changes`, mailbox lookup). It was extracted from `src/jmap/`
  once the email-agent became the second consumer (ADR 0004, Phase 1).
  Add new JMAP methods there, not in this service.
- Auth principal comes from `GET /oauth2/userinfo` against **Better Auth**
  (the OpenID Provider — same IdP as the web app) with the client's bearer;
  the principal is the `email` claim (the user's `username@langmail.me` mailbox
  address), cached as `(token, principal)` until token `exp`. The validated
  bearer is then forwarded to **Stalwart** for JMAP/CalDAV. See
  `../../docs/reference/security/authentication.md` for the identity model and
  why we don't gate on `aud` or `scope`.

## Configuration

Environment variables (set via `infra/modules/mcp.nix` — the container's
`environment` plus `environmentFiles = [ "/run/secrets/mcp.env" ]`):

| Var                   | Default                    | Notes                                               |
| --------------------- | -------------------------- | --------------------------------------------------- |
| `MCP_HOST`            | `127.0.0.1`                | bind address — keep loopback in prod (nginx fronts) |
| `MCP_PORT`            | `8080`                     | upstream port nginx proxies to                      |
| `MCP_PUBLIC_URL`      | `http://127.0.0.1:8080`    | full base URL, e.g. `https://mcp.langmail.me`       |
| `STALWART_PUBLIC_URL` | `https://mail.langmail.me` | JMAP/CalDAV egress — where the bearer is forwarded  |
| `AUTH_PUBLIC_URL`     | `https://auth.langmail.me` | Better Auth base; issuer = `${AUTH_PUBLIC_URL}/api/auth`, the AS the MCP server advertises + validates bearers against |

The `EnvironmentFile` may be empty on a fresh VM — defaults boot a
usable server, just with the wrong public URLs.
