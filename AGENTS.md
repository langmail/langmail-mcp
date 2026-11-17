# langmail-mcp

MCP server that gives an agent Langmail's email, calendar and contacts tools against the user's own Stalwart server, over JMAP, CalDAV and CardDAV. No Langmail infrastructure is involved.

## Tech Stack
- TypeScript, ESM (`"type": "module"`), Node ≥22, compiled with `tsc` to `dist/` (`tsconfig.build.json`; `tsconfig.json` typechecks `src/`, `e2e/`, `scripts/` and the config files without emitting; `npm run build` runs both).
- Relative imports keep their `.ts` extension; `rewriteRelativeImportExtensions` turns them into `.js` in `dist/`.
- Biome for lint + format (`npm run check` / `check:fix`) — do not add ESLint or Prettier.
- Vitest for tests, lefthook for git hooks, semantic-release for publishing.
- Runtime deps (`package.json` is authoritative): `@modelcontextprotocol/server` (the v2 MCP SDK), `zod`, `pino` (logging), `@date-fns/tz` (time zones in `src/ical`), `tsdav` (the CalDAV client in `src/caldav`), `ical-generator`, `rrule` and `@touch4it/ical-timezones` (writing events and expanding recurrences in `src/caldav`), `langmail` (email preprocessing for the mail tools), `@modelcontextprotocol/ext-apps` (registers `preview_email` and its viewer as an MCP App) and `sanitize-html` (cleans an email's HTML for that viewer). `@modelcontextprotocol/client` is a dev dependency: the end-to-end suites drive the built server with it.
- `esbuild` is a dev dependency used by `npm run build` only: `scripts/build-viewer.ts` bundles the email viewer into `dist/email-render/email-viewer.html`. The server reads that file and never loads a bundler.
- TypeScript is strict with `noUncheckedIndexedAccess`; `exactOptionalPropertyTypes` is off, because the hosted code these files come from is not written for it.
- No Bun APIs.

## Layout
- `src/index.ts` — server entry; loads the configuration and connects the server to the transport (stdio by default).
- `src/config.ts` — reads and validates the environment and the command line; the only place that reads `process.env` for settings.
- `src/tools/<tool>.ts` — one file per MCP tool, with `<tool>.test.ts` next to it.
- `src/mcp/handler.ts` — builds the server: `createRuntime` (JMAP session cache, credential, principal) and `createServer`, where each tool is registered with one line. `src/mcp/tool-logging.ts` logs one line per tool call.
- `src/http/` — the HTTP listener: `routes.ts` (a listener is a list of `Route`s; `createFetchHandler` dispatches to them and logs), `listener.ts` (serves that handler over `node:http`), `bearer.ts` (the `MCP_AUTH_TOKEN` check), `guard.ts` (Origin and Host checks). `src/mcp/http.ts` holds the `/mcp` routes.
- `src/attachments/` — the tickets behind file links and the routes that redeem them; `src/mcp/links.ts` — which routes those are, and the loopback listener a stdio server starts for them.
- `src/observability/errors.ts` — `describeError`: what an error log line may carry (no addresses, no credentials).
- `src/jmap/`, `src/contacts/`, `src/ical/` — JMAP client, contact and iCalendar helpers.
- `src/caldav/`, `src/rules/`, `src/drafts/`, `src/attachments/`, `src/email-render/` — what the tools build on.
- `src/email-render/viewer/` — the one piece of browser code: the view an MCP Apps host runs in its sandbox to show a previewed email. It has its own `tsconfig.json` (DOM types, no Node types), is bundled by `scripts/viewer-bundle.ts`, and must not import anything that needs Node.
- `src/logger.ts` — pino; logs go to stderr only, because stdout belongs to the stdio transport. `LOG_LEVEL` sets the level; the default is `warn`, and `info` adds one line per tool call.
- `e2e/` — suites that run against a real Stalwart.
- Configuration comes from the environment (see `.env.example`); dev loads `.env` via `tsx --env-file=.env`, not `dotenv`.

## Workflow
- Dev: `npm run dev` (watch). Build: `npm run build`. Test: `npm test`. Everything CI checks: `npm run validate`.
- After changing a tool's behaviour, run the end-to-end tests (see "End-to-end tests").

## Where this code comes from
The tools mirror Langmail's hosted MCP server. Tool names, inputs and descriptions must stay identical to the reference at <https://docs.langmail.me/reference/mcp/overview>. Change a description only where it names a tool this server does not have or a fact that is only true of the hosted service.

`src/mcp/hosted-parity.test.ts` enforces this. It compares what the server sends (`tools/list`, the instructions, `resources/list`; over stdio and HTTP, with the opt-in flags off and on) with `src/mcp/hosted-tools.snapshot.json`, the hosted server's definitions as sent over the wire. Two tables in the test are the only differences allowed: `LEFT_OUT` (hosted tools this server does not have) and `REWORDED` (every place the wording differs: the exact hosted text, the exact text here, and why). A difference that is not listed fails, and so does an entry that no longer applies.
- To change a description, an input-schema text or the instructions: change it in the source file, then add or update its `REWORDED` entry. Reword only for the two reasons above.
- To pick up a change from the hosted server: regenerate the snapshot as the header of the test describes, then bring over every difference the test reports.
- `e2e/all-tools.e2e.test.ts` calls every listed tool once through the built server, over stdio and over HTTP, and fails when a tool has no call. A new tool needs a call there.

Project invariants:
- Nothing leaves the user's machine or server except traffic to their own Stalwart, unless the user turns it on with an opt-in environment flag that defaults to off. No telemetry and no error reporting services.
- No Langmail address or service is a default anywhere (no `*.langmail.me` defaults).
- Nothing hosted-only comes along: no internal hostnames, secrets, or real people's names or addresses. All test data uses `example.com` addresses. Data-format identifiers that must stay compatible with existing mailboxes (the vCard property `langmail.me:collected`, `urn:langmail:authored:`) stay.

## Credentials
- The user signs in to their Stalwart with `STALWART_USERNAME` + `STALWART_PASSWORD` (an app password) or `STALWART_TOKEN`. `src/config.ts` turns either into one credential: the complete `Authorization` header value, `Basic …` or `Bearer …`.
- That credential is what every tool receives as its "token" (`runtime.getToken`). The hosted code calls the same value a bearer token and wrapped it with `bearerAuthorization(token)`; here that function is `authorizationHeader(credential)` in `src/jmap/session.ts` and returns its argument unchanged. Never add a scheme prefix anywhere else.
- In a test, pass the full header value in (`"Bearer tok"`, `"Basic …"`) and assert that it arrives unchanged.
- The principal (the mailbox address mail is sent from) is the `username` of the JMAP session, read through `runtime.getPrincipal`. The server signs in before every tool call (`runtime.signIn`, cached after the first success), never at start-up: the MCP handshake must not depend on the mail server.
- A credential never appears in a log line, an error message or a tool result. `describeError` redacts `Bearer …` and `Basic …` values.

## Transports
- stdio is the default: one `McpServer` for the life of the process (`src/index.ts`). It listens on no port until a tool hands out a file link or a host reads the email viewer template (see "File links", "Email preview").
- `--http` or `MCP_TRANSPORT=http` serves Streamable HTTP at `POST /mcp` on `MCP_HOST:MCP_PORT` (default `127.0.0.1:8080`). It is stateless: every request gets a fresh `McpServer` and transport (the SDK's `legacyStatelessFallback`), all sharing one runtime. `GET` and `DELETE` on `/mcp` answer 405.
- Every `/mcp` request must carry `Authorization: Bearer <MCP_AUTH_TOKEN>`. The token is required (at least 16 characters) and compared in constant time. Anything else gets `401` with `WWW-Authenticate: Bearer` and the body `{"error":"unauthorized"}`, before the request body is read. A 401 must never say anything about the server, its tools or the mail server.
- There is no OAuth and there are no `/.well-known/` documents. `GET /healthz` answers `ok` without the token and says nothing else. The file-link routes under `/attachments/` take a ticket instead of the token (see "File links"). Every other path is a 404.
- `guard.ts` refuses (403) a request whose `Origin` is not the listener's own address, and, when bound to loopback, one whose `Host` is not a loopback name or the public URL's. No CORS headers are sent anywhere.
- The server speaks plain HTTP. Binding a non-loopback `MCP_HOST` prints a warning to put a TLS-terminating reverse proxy in front.
- To add routes to the listener, append `Route`s to the list in `serveHttp` (`src/index.ts`). A route names its `path` (a trailing slash makes it a prefix), decides for itself what it requires of the caller, and sets `logAs` only if its path is not a secret. `startHttpListener` plus `createFetchHandler` also serve a list without `/mcp`.
- One info line per `/mcp` request (method, route name, status, duration). Never log the token, the `Authorization` header or a request path.

## File links
- `download_attachment`, `download_email` and `upload_attachments` answer with a URL, never with file content: the agent fetches it or PUTs to it with `curl`, so the bytes stay out of the conversation. Keep it that way.
- The URL carries a ticket (32 random bytes, base64url) and the route asks for nothing else, not even `MCP_AUTH_TOKEN`: `GET /attachments/<ticket>` (valid 24 hours, any number of times) and `PUT /attachments/uploads/<ticket>` (valid 15 minutes, once, at most 25 MB). Tickets live in memory (`runtime.tickets`, `runtime.uploadTickets`), so a restart ends them. A ticket holds the Stalwart credential on the server side; it never reaches the agent.
- A tool that mints a link asks `runtime.publicUrl()` for the base URL at that moment, never earlier. `linkRoutes(runtime)` in `src/mcp/links.ts` is the list of routes that redeem links; add a new kind of link there and both transports serve it.
- HTTP transport: the routes are on the same listener as `/mcp`, and links are minted under `MCP_PUBLIC_URL`. A reverse proxy in front must pass `/attachments/` through and should not write those paths to its access log: the path is the credential.
- stdio transport: the first link starts a listener for `linkRoutes` alone (`startLinkListener`): `127.0.0.1` always, on `MCP_PORT` if set and free, otherwise a port the system picks. It has no `/mcp` and no health route, runs behind the same `guard.ts`, and does not keep the process alive. A server that never hands out a link opens no port. If the listener cannot start, that tool call fails and the next one tries again.
- Never log a ticket, a link or a file name. The routes set no `logAs`; the handlers log status and size.

## Sending mail
- `send_draft`, `reply_to_message` and `forward_message` deliver mail through the user's Stalwart (`EmailSubmission/set`). `create_draft` and `update_draft` only write to the Drafts folder.
- The From address is the Identity (`Identity/get`) whose address equals the principal; `from` picks another of the account's identities (an alias) and is refused for any other address. Stalwart names the account's primary address as the session `username` whatever login name was typed (the address, the bare local part, an alias, or an API key), so the default From is the primary address.
- Two pieces of process-lifetime state in `createRuntime` keep a retried send from delivering twice: `runtime.sendGuard` reserves a draft while its send is in flight, and `runtime.composeReplays` returns the first answer for a repeated `idempotencyKey` (kept 15 minutes). Both are in memory and shared by every server the HTTP listener builds; a restart clears them.
- In `sendDraft` and `replyToMessage`, the replay lookup and the reservation happen in one synchronous step before the first `await`, and the answer is recorded before the reservation is released. Do not move a `holdSend`, an `await` or a `replays.record` relative to each other: that order is what stops a retry from sending a second copy.
- Tests and e2e suites send only between accounts they created on the test Stalwart (`example.com`), never to another host.
## Email preview
- `preview_email` answers with metadata for the model (`structuredContent`) and the sanitised HTML for the user in result `_meta`, which an MCP Apps host passes to the viewer template `ui://langmail/email-viewer` and keeps out of the conversation. `ui://langmail/email-viewer` and the `_meta` key `me.langmail/email-preview` are identifiers shared with the bundled view; do not rename them.
- The viewer is built, not written at run time: `npm run build` bundles `src/email-render/viewer/email-viewer.ts` with the MCP Apps SDK into `dist/email-render/email-viewer.html`, and `resources/read` serves that file. Unit tests build it themselves into a temporary directory (`scripts/viewer-bundle.ts`), so `npm test` needs no prior build. A server run from source (`npm run dev`) serves the viewer of the last build.
- Every `<img>` in the previewed HTML is rewritten or dropped (`src/email-render/sanitize.ts`): a `cid:` image becomes an attachment link (see "File links"), a raster `data:` image stays, anything else is dropped.
- Remote images are off by default. Without `LANGMAIL_MCP_ALLOW_REMOTE_IMAGES=1` the runtime has no image-token store (`runtime.imageTokens`), `linkRoutes` has no `/image-proxy/` route, remote `<img>` elements are dropped, and the tool result says how many were left out. With it, a remote https image becomes `GET /image-proxy/<token>` on this server (valid 24 hours), which fetches the image from the sender's host: every address the host resolves to must be public, the connection goes to the checked address while TLS verifies the sender's host name (`makePinnedFetch`, on `node:https`), redirects and non-raster types are refused, and the size is capped at 10 MB. Keep it that way: the URL is the sender's.
- The viewer template declares one origin it may load from (`_meta.ui.csp.resourceDomains`): this server's own, where the image links live. Over HTTP that is the public URL's origin, in the listing and in the content. Over stdio the origin is the loopback link listener's, which is only known once it runs: `resources/list` names no origin, and `resources/read` starts the listener and names it. Listing tools and resources must never open a port.
- A host enforces that CSP; the server cannot. CSS in an email (`<style>`, `style=`) is kept for layout and may name remote URLs, which a host that follows the MCP Apps rules never loads.

## Working with the user
- When the user asks a question, answer it before editing files or running implementation commands.
- When responding to feedback or a review, say whether you agree or disagree before saying what you changed.
- Explain non-trivial designs or bugs as problem → concrete example or short trace → solution, and say why any added complexity is needed.

## Dependencies
- Treat `package.json` and `package-lock.json` changes as reviewed code; say why a dep is added or bumped.
- `.npmrc` pins new deps to exact versions (`save-exact`) and ignores versions published less than 2 days ago (`min-release-age`). Don't rewrite existing `^` ranges.
- `min-release-age` only applies when npm resolves a version (`npm install <pkg>`, `npm update`). npm 10 does not know the setting and ignores it; use npm 11 or later when adding or bumping deps. `npm ci` installs the lockfile as is.
- Ask before adding a dep that has lifecycle scripts (`preinstall`, `install`, `postinstall`).
- Install locally with scripts on: `prepare` runs `lefthook install`, so `--ignore-scripts` skips the git hooks. `npm ci --ignore-scripts` fits CI jobs that only need `node_modules`.

## End-to-end tests
`npm run test:e2e` builds, then runs the suites in `e2e/` (`*.e2e.test.ts`) against a real Stalwart at the version in `.stalwart-version`. See `e2e/README.md` for how to start one and which environment variables the suites read.

`.mcp.json` at the repo root registers the built server (loads `.env` via `node --env-file`) so interactive Claude Code sessions pick it up automatically.

## Lint policy for ported code
Most of `src/` is copied from Langmail's hosted server, which runs Biome with the same ultracite preset minus a few rules. Those rules are off here too (`biome.json`), so the copied files stay line-for-line comparable with their source. Counts are findings across the whole ported source when the policy was set:

| Setting | Findings | Why it is off |
| --- | --- | --- |
| `assist` `useSortedKeys` | (auto-fix) | Sorting object keys changes behaviour: key order decides `Object.entries` iteration and the order of fields in a tool's JSON output. |
| `suspicious/noUnnecessaryConditions` | 97 | Flags guards on values the types call non-null. The values come from a mail server and from other clients' data, and the guards are deliberate. |
| `style/useDestructuring` | 68 | Style only. |
| `performance/noAwaitInLoops` | 63 | The loops are sequential on purpose: ordered writes, polling, paging. |
| `suspicious/noMisplacedAssertion` | 30 | Test helpers that assert are called from inside tests. |

Every other rule stays on. Fix what it reports in the file: `i++` → `i += 1` (`noIncrementDecrement`), `== null` → explicit checks (`noEqualsToNull`), a `// biome-ignore lint/suspicious/noControlCharactersInRegex: <reason>` on a regex that matches control characters on purpose. `noUndeclaredVariables` on `Bun` and `noUndeclaredDependencies` are real findings: replace the Bun API, add the dependency. Do not turn off further rules.

`knip.json` ignores unused exports and exported types in `src/jmap/index.ts`, `src/jmap/email.ts` and `src/contacts/index.ts`, and nothing else: vendored libraries keep their full API so they can be re-synced from upstream. What no tool here uses (6 functions, such as `emailChanges` and `emailState`, which only the hosted service's mail sync calls, and 48 types) stays exported; do not prune it, and do not widen the ignore to other files.

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `npx ultracite fix`
- **Check for issues**: `npx ultracite check`
- **Diagnose setup**: `npx ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns
- Avoid import cycles; move shared code into a module both sides import

### Security

- Add `rel="noopener noreferrer"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome will catch most mechanical issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `npx ultracite fix` before committing to ensure compliance.
