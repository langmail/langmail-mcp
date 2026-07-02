# services/mcp — operational notes

MCP resource server. Runs on the `app` VM, fronted by nginx for TLS +
ACME; authenticates clients against Better Auth (OAuth/OIDC) and talks to
Stalwart over public HTTPS for JMAP + CalDAV.

This README captures per-service conventions. Repo-wide guidance lives
in `../../AGENTS.md`; the design rationale lives in
`../../spec/03-monorepo-and-app-vm.md` and `../../spec/02-mcp.md`.

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

## Adding tools (preview of phase 4)

When `spec/02-mcp.md` lands, the `/mcp` route in `src/index.ts` will
mount `StreamableHTTPServerTransport` and register tools. Conventions:

- One file per tool under `src/tools/`. Default-export a registration
  function that takes the `McpServer` and adds the tool.
- JMAP wire shape lives in the shared `@langmail/jmap` package (typed
  `fetch` wrappers: `Email/query`, `Email/get`, `Email/set`,
  `Email/changes`, mailbox lookup). It was extracted from `src/jmap/`
  once the email-agent became the second consumer (ADR 0004, Phase 1 of
  `docs/proposals/2026-07-02-jmap-first-email-agent/`). Add new JMAP
  methods there, not in this service.
- Auth principal comes from `GET /oauth2/userinfo` against **Better Auth**
  (the OpenID Provider — same IdP as app + webmail) with the client's bearer;
  the principal is the `email` claim (the user's `username@langmail.me` mailbox
  address), cached as `(token, principal)` until token `exp`. The validated
  bearer is then forwarded to **Stalwart** for JMAP/CalDAV. See
  `../../docs/reference/security/authentication.md` for the identity model and
  `../../spec/03-monorepo-and-app-vm.md §MCP RS auth model` for why we don't
  gate on `aud` or `scope`.

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
