# services/mcp — operational notes

MCP resource server. Runs on the `app` VM, fronted by nginx for TLS +
ACME; authenticates clients against Better Auth (OAuth/OIDC) and talks to
Stalwart over public HTTPS for JMAP + CalDAV.

The public endpoint is `https://mcp.langmail.me/mcp` (Streamable HTTP).
Repo-wide guidance lives in `../../AGENTS.md`; the identity design in
`../../docs/adr/0003-better-auth-as-openid-provider.md`.

## Tech Stack
- **MCP TypeScript SDK v2**: `@modelcontextprotocol/server` (the
  per-request `McpServer` and the web-standard Streamable HTTP transport) and
  `@modelcontextprotocol/client` (`scripts/smoke.ts`).
- **MCP Apps** (`@modelcontextprotocol/ext-apps`): the email viewer resource.
- **Zod 4**: tool input and output schemas.
- **langmail**: email preprocessing (see the root `AGENTS.md`).

## Stalwart upstream issues
CalDAV/iMIP defects this service works around → `docs/upstream/stalwart/`
(scheduling behaviour that is by design → `docs/reference/stalwart/observed-behaviour.md`).
Read the matching issue file before changing a workaround; each has a
"Drop workaround when" clause.

## Runtime: Bun for the hosted image, Node or Bun for the package

The **hosted server** is Bun-only. It ships as a container image (`oven/bun`
base) that runs the TypeScript from source; the target VM does not install
Node and never will. `src/index.ts` may use Bun APIs (`Bun.serve`).

The **self-hosted server** (`src/self-hosted.ts`) also ships as the
`langmail-mcp` npm package, which runs under Node (`engines`: 22.12 or later,
not 23) and Bun:
`npx langmail-mcp`, or `bunx --bun langmail-mcp`. Code it reaches calls no
Bun API at runtime and imports no workspace package:

- `bun run build:package` (`scripts/build-package.ts`, also `npm pack`'s
  `prepack`) bundles `src/self-hosted.ts` for Node into `dist/`, with npm
  dependencies external. It swaps two modules: `email-render/viewer-build.ts`
  becomes the viewer HTML it built, so there is no `Bun.build` at runtime,
  and `runs-from-source.ts` says false, so the logger writes no repo log
  file. It fails when the bundle mentions a Bun API or `@langmail/*`.
- The HTTP listener is `src/self-hosted/listen.ts` on `node:http`, under both
  runtimes, in place of `Bun.serve`.
- Import a CommonJS package (`langmail`, `rrule`) by its default export:
  Node does not see its named exports from ESM.
- `bun run test:node` (`scripts/test-node.ts`) bundles the self-hosted tests
  the same way and runs them with `node --test`; they use `node:test` and
  `node:assert`, which `bun test` runs too. `bun run check:package [--runtime
  node|bun]` (`scripts/check-package.ts`) packs the package, installs the
  tarball into an empty project and starts the bin over stdio and HTTP
  against a fake Stalwart. CI runs both under the Node LTS and 22.12 in
  `.github/workflows/test-mcp-package.yml`.
- Nothing publishes the package from this repository (`private: true`);
  publishing starts with the move to `langmail/langmail-mcp`
  (https://github.com/langmail/platform/issues/1349).

Commands:

- `bun install` — installs into `node_modules/`; writes `bun.lock`.
- `bun run dev` — local dev server on `127.0.0.1:8090` (the `MCP_PORT` set by
  `process-compose.yaml`; `8080` is the default when `MCP_PORT` is unset, but
  `apps/web` takes it).
- `bun run build` — `tsc --noEmit` type check (the turbo "build" gate;
  the container runs from source, so there is no compile/bundle step).
- `bun run start` — production entrypoint (`NODE_ENV=production bun
  src/index.ts`), what the container's `CMD` runs.
- `bun run typecheck` — typecheck only.
- `bun run spec:check` — TLC run of the send-protocol model; see
  `spec/AGENTS.md` before touching `sendDraft` or `replyToMessage`.

Point a local client at the dev server through `local-proxy` with
`claude mcp add --transport http langmail-local https://mcp.langmail.test:8088/mcp`:
`.env.development` sets that origin as `MCP_PUBLIC_URL`, so OAuth fails on the
loopback port.

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

Scripts run under Bun (`bun run …`); `node` appears only where a script
checks the package under Node (`test-node.ts`, `check-package.ts`). If a
dependency is node-only and won't run under Bun, find another or write the
call inline.

## Build + deploy: container image, pinned by digest

The artifact is a container image, not a Nix-built package — nixpkgs
has no first-class `buildBunModule`, and a container is the
language-agnostic unit shared with the deprecated stack. Pipeline:

1. Push to `main` → `.github/workflows/deploy-mcp.yml` tests, builds
   `services/mcp/Dockerfile`, pushes `ghcr.io/langmail/platform-mcp`,
   and commits the new `@sha256` digest into `infra/modules/mcp.nix`.
2. comin on the `app` VM applies the bump within about a minute: NixOS
   pulls the pinned image and (re)starts the `podman-mcp` container behind
   nginx (`just rebuild-app` is the break-glass path). A fresh VM can't pull the
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
- The server imports no workspace package, so it can build outside this
  repository. JMAP wire shape lives in `src/jmap/`, the
  iCalendar parser in `src/ical/`, contact collection in `src/contacts/`,
  logging in `src/logger/` and the readiness runner in
  `src/health/readiness-runner.ts`. `src/jmap/` and `src/contacts/` are
  copies of `packages/jmap` and `packages/contacts`, which the email-agent
  uses; a change to the collection rules goes into both copies, and
  `packages/contacts/src/mcp-collection-parity.test.ts` fails when they
  differ. `src/tools/email-types.ts` copies the taxonomy in
  `packages/agents`, held equal by
  `packages/agents/src/mcp-email-type-parity.test.ts` (ADR 0010). The
  `src/jmap/` and `src/logger/` copies have no such guard: each side's own
  tests cover its copy, and the two may drift.
- Auth principal comes from `GET /oauth2/userinfo` against **Better Auth**
  (the OpenID Provider — same IdP as the web app) with the client's bearer;
  the principal is the `email` claim (the user's `username@langmail.me` mailbox
  address), cached as `(token, principal)` until token `exp`. The validated
  bearer is then forwarded to **Stalwart** for JMAP/CalDAV. See
  `../../docs/reference/security/authentication.md` for the identity model and
  why we don't gate on `aud` or `scope`.

## Self-hosted mode

`src/self-hosted.ts` (`bun run start:self-hosted`, or `npx langmail-mcp` from the package) runs the same tools against
someone's own Stalwart with `STALWART_URL`, `STALWART_USERNAME` and
`STALWART_PASSWORD`, over stdio by default or Streamable HTTP behind
`MCP_AUTH_TOKEN`, with no Better Auth and no Auth service. Settings, startup
checks and what it leaves out: `../../docs/reference/mcp-self-hosted.md`.

- The mode is `McpHandlerConfig.mode` (`src/mode.ts`), set by the entrypoint.
  A tool whose wording or schema differs takes a `mode` argument that
  defaults to `hosted`; today `search_emails` and the contact tools.
- `src/mcp/tool-surface.test.ts` pins the hosted tool surface. A diff there is
  a hosted change: regenerate the snapshot only when it is meant.
- Over stdio, stdout is the protocol: log through `logger`, which the
  entrypoint points at stderr, never `console.log` or `process.stdout`.

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
| `AUTH_SERVICE_URL`    | `AUTH_PUBLIC_URL`          | Auth base for its `/internal/*` endpoints            |
| `AUTH_INTERNAL_TOKEN` | unset                      | Bearer for Auth's internal endpoints: calendar sharing, share feeds, agent activity (`src/auth-internal.ts`). Unset, those are off and the sharing tools are not offered |

The `EnvironmentFile` may be empty on a fresh VM — defaults boot a
usable server, just with the wrong public URLs. The server has no database
connection: Langmail's own data (calendar shares, the agent-activity row)
goes through Auth.
