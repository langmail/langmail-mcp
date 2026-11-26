# langmail-mcp

Langmail's MCP server. One codebase runs two ways:

- **Hosted** (`src/index.ts`): the server at `https://mcp.langmail.me/mcp`,
  deployed from a release of this repository. Clients sign in with OAuth
  against Langmail's Auth service (Better Auth), and the server forwards the
  validated bearer to Langmail's Stalwart. The rest of Langmail (Auth, the
  email agent, the infrastructure) lives in the private `langmail/platform`
  repository.
- **Self-hosted** (`src/self-hosted.ts`): the `langmail-mcp` npm package. It
  signs in to someone's own Stalwart with a username and app password, over
  stdio or Streamable HTTP, with no Langmail service
  (`docs/self-hosted.md`).

## Factory

What `WORKFLOW.md` and the shared skills need to know about this repository.

- **Issues:** GitHub issues in `langmail/langmail-mcp` are for reports from
  outside, and an agent run on one of them files its follow-ups here.
  Langmail's own planned work on the server, and its follow-ups, is filed in
  `langmail/platform`, and commit messages from before the move cite those
  issues as `langmail/platform#123`. A defect in Stalwart or another
  dependency is a file under `docs/upstream/` (Upstream defects).
- **Priorities:** No list here: every issue is for now until the maintainer
  says otherwise. Triage closes a `needs-info` issue as not planned once it
  has had no reply for 14 days since it started waiting (the latest of the
  comment that asked, the label, a reopening and the latest reply), unless
  it is `urgent` or assigned.
- **Scope:** No backwards compatibility inside the code: break internal APIs
  freely and delete old code. A change that breaks what an MCP client or a
  package user sees is a breaking change and gets a `BREAKING CHANGE:`
  footer, which semantic-release turns into a major version; it ignores a
  `!` after the type.
- **Plan:** Nothing beyond `WORKFLOW.md`.
- **Dev stack:** `bun run start:self-hosted` runs the self-hosted server
  from source, and the Stalwart tests need the dev Stalwart in
  `infra/dev/stalwart` (Tests against real servers). The hosted server runs
  only inside `langmail/platform`'s local stack (Commands).
- **Verify:** The checks in `CONTRIBUTING.md` (Checks) that the change
  touches, which CI runs too; a change to a tool's name, description, schema
  or result also needs an agent eval before and after (`docs/evals.md`).
  A session that cannot run it, such as a routine with no `claude` login,
  lists `- [ ] before merge: the maintainer runs the agent eval` under the
  PR's Deploy instead.
- **Ship:** A change to a tool's behavior or schema also updates its public
  reference page in the same PR (Adding or changing tools).
- **Release:** Release and deploy, below. Nobody acts, except that a breaking
  change publishes a major version, so its PR's Deploy section lists
  `- [ ] before merge: the maintainer approves the major release`.
- **Dependencies:** `bun outdated` lists outdated packages, and Tech stack
  lists the stack. Dependabot opens the minor and patch updates weekly as one
  group; majors are the `upgrade-dependency` skill's. The bun runtime moves
  in one PR: `BUN_VERSION` in `.github/workflows/release.yml` and
  `FROM oven/bun:` in `Dockerfile`. Holds are the files in `docs/upstream/`,
  except `stalwart/`. Left out: Stalwart (`infra/dev/stalwart`), which moves
  with `langmail/platform`'s Stalwart, and GitHub Actions unless their
  Dependabot PR is red.

## Workflow

Read `WORKFLOW.md` at the start of every session and follow it. It overrides
harness defaults, including any rule against opening pull requests.

@WORKFLOW.md

## Tech stack

- **MCP TypeScript SDK v2**: `@modelcontextprotocol/server` (the
  per-request `McpServer` and the web-standard Streamable HTTP transport) and
  `@modelcontextprotocol/client` (`scripts/check-package.ts`).
- **MCP Apps** (`@modelcontextprotocol/ext-apps`): the email viewer resource.
- **Zod 4**: tool input and output schemas.
- **langmail** (npm, from `langmail/langmail`): email preprocessing for
  language models.
- **tsdav** for CalDAV and CardDAV; JMAP is called directly (`src/jmap/`).

## Runtime: Bun for the hosted image, Node or Bun for the package

The **hosted server** is Bun-only. It ships as a container image (`oven/bun`
base) that runs the TypeScript from source. `src/index.ts` may use Bun APIs
(`Bun.serve`).

The **self-hosted server** also ships as the `langmail-mcp` npm package, which
runs under Node (`engines`: 22.12 or later, not 23) and Bun: `npx
langmail-mcp`, or `bunx --bun langmail-mcp`. Code it reaches calls no Bun API
at runtime:

- `bun run build:package` (`scripts/build-package.ts`, also `npm pack`'s
  `prepack`) bundles `src/self-hosted.ts` for Node into `dist/`, with npm
  dependencies external. It swaps two modules: `email-render/viewer-build.ts`
  becomes the viewer HTML it built, so there is no `Bun.build` at runtime,
  and `runs-from-source.ts` says false, so the logger writes no log file. It
  fails when the bundle mentions a Bun API.
- The HTTP listener is `src/self-hosted/listen.ts` on `node:http`, under both
  runtimes, in place of `Bun.serve`.
- Import a CommonJS package (`langmail`, `rrule`) by its default export:
  Node does not see its named exports from ESM.
- `bun run test:node` (`scripts/test-node.ts`) bundles the self-hosted tests
  the same way and runs them with `node --test`; they use `node:test` and
  `node:assert`, which `bun test` runs too. `bun run check:package [--runtime
  node|bun]` (`scripts/check-package.ts`) packs the package, installs the
  tarball into an empty project and starts the bin over stdio and HTTP
  against a fake Stalwart.

Scripts run under Bun (`bun run …`); `node` appears only where a script
checks the package under Node (`test-node.ts`, `check-package.ts`). If a
dependency is node-only and won't run under Bun, find another or write the
call inline.

## Commands

- `bun install`: installs into `node_modules/` and writes `bun.lock`.
- `bun test`: the unit suite.
- `bun run typecheck` (also `build`): `tsc --noEmit` for the server and the
  email viewer. The image runs from source, so there is no compile step.
- `bun run check` / `check:fix`: Biome with the Ultracite preset.
- `bun run start:self-hosted`: the self-hosted server from source
  (`docs/self-hosted.md`).
- `bun run dev` / `start`: the hosted server. It needs Langmail's Auth service
  and Stalwart, so it runs inside `langmail/platform`'s local stack, which
  starts it from a checkout of this repository at `../langmail-mcp`.
- `bun run spec:check`: TLC run of the send-protocol model; read
  `spec/AGENTS.md` before touching `sendDraft` or `replyToMessage`.

## Tests against real servers

- `bun run test:integration` drives the CalDAV adapter against a live server
  and skips unless `CALDAV_BASE_URL` / `CALDAV_USERNAME` / `CALDAV_PASSWORD`
  are set. CI runs it against a throwaway Radicale; locally:

  ```bash
  pip install radicale
  printf 'test:test\n' > /tmp/radicale-users
  radicale --auth-type htpasswd --auth-htpasswd-filename /tmp/radicale-users \
    --auth-htpasswd-encryption plain --storage-filesystem-folder /tmp/radicale &
  CALDAV_BASE_URL=http://127.0.0.1:5232 CALDAV_USERNAME=test CALDAV_PASSWORD=test \
    bun run test:integration
  ```

- `bun run test:stalwart` runs the tests that need Stalwart's own behaviour
  against the dev Stalwart in `infra/dev/stalwart`, whose version is pinned in
  `infra/dev/stalwart/version.json`. Each test file says what it needs.
- The agent evals in `scripts/smoke-agent-*.ts` drive a real agent:
  `docs/evals.md`.

## Adding or changing tools

Load the `mcp-tool-design` skill before adding or changing a tool. This
repository's own conventions for tools are in `docs/tool-conventions.md`.

- One file per tool under `src/tools/`, exporting a `register<Tool>`
  function that `src/mcp/handler.ts` calls with the `McpServer`.
- The public tool reference is `docs/reference/mcp/<tool>.mdx`, published at
  <https://docs.langmail.me/reference/mcp/overview>. A change to a tool's
  behaviour or schema updates that page in the same pull request
  (`docs/AGENTS.md`).
- `src/mcp/tool-surface.test.ts` pins the hosted tool surface. A diff there is
  a hosted change: regenerate the snapshot only when it is meant.
- `src/contacts/` and the email type list in `src/tools/email-types.ts` have
  copies in `langmail/platform` that its email agent uses. Two tests there,
  `mcp-collection-parity.test.ts` and `mcp-email-type-parity.test.ts`, import
  this repository at the version production runs and fail when the copies
  differ. A change to the contact collection rules or the email types needs
  the same change there.

## Self-hosted mode

- The mode is `McpHandlerConfig.mode` (`src/mode.ts`), set by the entrypoint,
  never guessed from environment variables. A tool whose wording or schema
  differs takes a `mode` argument that defaults to `hosted`; today
  `search_emails` and the contact tools.
- No self-hosted tool text names Langmail; `src/mcp/instructions.test.ts`
  checks it.
- Over stdio, stdout is the protocol: log through `logger`, which the
  entrypoint points at stderr, never `console.log` or `process.stdout`.

## Hosted mode

The hosted server authenticates each request at Better Auth's
`GET /oauth2/userinfo` with the client's bearer. The principal is the `email`
claim (the user's mailbox address), cached as `(token, principal)` until the
token's `exp`. The validated bearer is then forwarded to Stalwart for JMAP,
CalDAV and CardDAV. Features that need Langmail's database (calendar sharing,
the agent-activity record) reach Auth's internal endpoints with
`AUTH_INTERNAL_TOKEN` (`src/auth-internal.ts`); without it they are off.

| Var | Default | Notes |
| --- | --- | --- |
| `MCP_HOST` | `127.0.0.1` | Bind address; loopback in production, behind nginx |
| `MCP_PORT` | `8080` | Port nginx proxies to |
| `MCP_PUBLIC_URL` | `http://127.0.0.1:8080` | Full base URL, such as `https://mcp.langmail.me` |
| `STALWART_PUBLIC_URL` | `https://mail.langmail.me` | Where JMAP, CalDAV and CardDAV requests go with the bearer |
| `AUTH_PUBLIC_URL` | `https://auth.langmail.me` | Better Auth base; the issuer is `${AUTH_PUBLIC_URL}/api/auth` |
| `AUTH_SERVICE_URL` | `AUTH_PUBLIC_URL` | Auth base for its `/internal/*` endpoints |
| `AUTH_INTERNAL_TOKEN` | unset | Bearer for Auth's internal endpoints; unset, calendar sharing and agent activity are off |

`.env.development` holds the values for `langmail/platform`'s local stack.

## Release and deploy

A merge to `main` runs `.github/workflows/release.yml`: the checks, then
semantic-release, which computes the version from the commit messages,
publishes the npm package, tags the release and writes `CHANGELOG.md`. The
same run builds the hosted image from `Dockerfile`, pushes it to
`ghcr.io/langmail/langmail-mcp`, and sends its digest to `langmail/platform`,
which pins it for production. Only a release deploys: `feat`, `fix`, `perf`
and `refactor` commits release (`.releaserc.json`), while `docs`, `test`,
`chore` and `ci` commits wait for the next release. Dependabot bumps runtime
dependencies as `fix(deps)` for that reason.

## Upstream defects

Defects in Stalwart, `@date-fns/tz` and `timezones-ical-library` that the
code works around are recorded under `docs/upstream/` (`docs/upstream/AGENTS.md`).
Read the matching entry before changing a workaround; each has a "Drop
workaround when" clause.
