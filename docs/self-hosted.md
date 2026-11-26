# Self-hosted MCP server

Someone with their own Stalwart, a username and an app password runs the MCP
server with `npx langmail-mcp` under Node, the same package under Bun, or
from source under Bun, with no Langmail service. Their agent then works
with the mail, calendar and contacts of that one mailbox, on the same computer
(stdio) or over the network (Streamable HTTP behind a secret the operator
sets).

The decisions and the options rejected are on
<https://github.com/langmail/platform/issues/1351> and
<https://github.com/langmail/platform/issues/1353>. Running under Node and the
`npx langmail-mcp` package are
<https://github.com/langmail/platform/issues/1355>.

## Starting it

### From the package

The `langmail-mcp` npm package runs the self-hosted server under Node 22.12
or later (not 23, which a dependency leaves out) or Bun. Its bin is `langmail-mcp`, and `langmail-mcp --help`
lists every setting with its variable.

```sh
# On the same computer: the MCP client starts the server and talks over stdio.
STALWART_URL=https://mail.example.com STALWART_USERNAME=alice \
  STALWART_PASSWORD=<app password> npx langmail-mcp

# Under Bun: --bun, or bunx follows the bin's node shebang.
STALWART_URL=https://mail.example.com STALWART_USERNAME=alice \
  STALWART_PASSWORD=<app password> bunx --bun langmail-mcp

# Over the network.
STALWART_URL=https://mail.example.com STALWART_USERNAME=alice \
  STALWART_PASSWORD=<app password> MCP_AUTH_TOKEN=<long random secret> \
  npx langmail-mcp --transport http --host 0.0.0.0 --port 8080
```

To try a change before it is released, build the tarball with `npm pack`
(its `prepack` runs `bun run build:package`) and start it with
`npx --package ./langmail-mcp-<version>.tgz langmail-mcp`.

How the package is built and checked: `AGENTS.md` § Runtime.
In short, `scripts/build-package.ts` bundles `src/self-hosted.ts` for Node
with the email viewer already built, the HTTP listener is `node:http`
(`src/self-hosted/listen.ts`) under both runtimes, and CI
(`.github/workflows/release.yml`) runs the self-hosted tests under
Node and starts the packed tarball with `npx`.

### From source

The entrypoint is `src/self-hosted.ts`; `src/index.ts` stays the
hosted server. Start it with `bun run start:self-hosted`, or with
`bun --no-env-file src/self-hosted.ts`: without `--no-env-file`, Bun loads the
repository's `.env.development`, whose `MCP_PUBLIC_URL` would
point the minted attachment links at the hosted dev server. From a clone,
after `bun install`:

```sh
STALWART_URL=https://mail.example.com STALWART_USERNAME=alice \
  STALWART_PASSWORD=<app password> bun run start:self-hosted
```

The flags are the same as the package's.

## Settings

Settings come from the shell's environment or from flags; `.env` files are
not read (`start:self-hosted` runs `bun --no-env-file`). A flag wins over its
variable. The two secrets have no flag, because a flag shows in the process
list.

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `STALWART_URL` | `--stalwart-url` | required | Stalwart's base URL; JMAP, CalDAV and CardDAV are reached under it |
| `STALWART_USERNAME` | `--username` | required | The account name to sign in with |
| `STALWART_PASSWORD` | none | required | An app password for that account |
| `STALWART_EMAIL` | `--email` | the login Stalwart reports | The address to send mail as; needed when the login is not an email address and the account has several sending identities |
| `MCP_ACCESS` | `--access` | `everything` | What the agent may do: `read-only`, `no-send` or `everything` ([Access levels](#access-levels)) |
| `MCP_TRANSPORT` | `--transport` | `stdio` | `stdio` or `http` (Streamable HTTP) |
| `MCP_HOST` | `--host` | `127.0.0.1` | Where the HTTP listener binds |
| `MCP_PORT` | `--port` | `8080` for http; a free port for stdio | The HTTP listener's port |
| `MCP_PUBLIC_URL` | `--public-url` | `http://<host>:<port>`, with a wildcard host as `127.0.0.1` | Base URL the attachment and image links are minted under |
| `MCP_AUTH_TOKEN` | none | required for http | The bearer every `/mcp` request must carry |

`http` refuses to start without `MCP_AUTH_TOKEN`, on loopback too: a web page
in the user's browser can reach a local port. A request without
`Authorization: Bearer <MCP_AUTH_TOKEN>` gets 401, and no OAuth discovery
(`/.well-known/oauth-*`) is served.

Over stdio a small HTTP listener still runs, for the links
`download_attachment`, `download_email`, `upload_attachments` and
`preview_email` mint (`/attachments/…`, `/image-proxy/…`). The unguessable token
in each link is its credential, as on the hosted server.

Logs go to stderr, since stdout carries the stdio protocol; `LOG_LEVEL` sets
their level (`info` by default). Log shipping and error tracking use the
hosted settings (`BETTERSTACK_SOURCE_TOKEN`, `BETTERSTACK_ENDPOINT`,
`BETTERSTACK_ERRORS_DSN`) and, as hosted, run only with
`NODE_ENV=production`; unset, nothing is sent. From source in this
repository, a development run also writes `logs/mcp-self-hosted.log`; the
package writes no log file.

## Access levels

`--access` (or `MCP_ACCESS`) sets what the agent may do through the server:
`read-only` (Read only), `no-send` (Change, never send) or `everything`
(Everything, the default). Langmail is to offer the same levels per agent
(<https://github.com/langmail/platform/issues/1452>), and the one table of which tools each level allows is
[Access levels](reference/mcp/overview.mdx#access-levels) in the tool
reference; `src/access/levels.test.ts` fails when it disagrees with
`src/access/levels.ts`. The startup log names the level. A tool outside the
level is left out of the tool list, and a call to it from a client's cached
list is refused, saying nothing was changed or sent and that the level is set
with `--access`.

What differs from Langmail:

- `share_calendar` and `stop_sharing_calendar` exist only on Langmail
  ([What the mode leaves out](#what-the-mode-leaves-out)), so Everything
  self-hosted has no calendar sharing.
- The level is fixed for the life of the process and holds for every client:
  changing it needs a restart with the new value. On Langmail the user is to
  change it per agent under Access.
- The level limits what the agent does through `langmail-mcp` only. The
  Stalwart app password keeps full rights on the account, so whatever else
  holds it can still do everything.

The decisions and the options rejected are on
<https://github.com/langmail/platform/issues/1447>.

## Startup checks

- A missing or invalid setting, an unknown `--access` value included: one message on stderr names each, with its
  flag and what to put there, and the process exits with code 2.
- The server asks Stalwart for the JMAP session once. Rejected credentials
  stop the start with the URL and username Stalwart rejected. So does a
  session whose API, download or upload URL is on another origin than
  `STALWART_URL`: the tools call those URLs as advertised, so the two must
  agree.
- The sending identity is picked by `STALWART_EMAIL`, else by the login
  Stalwart reports for the session, falling back to the account's only
  identity (`src/tools/draft-common.ts`). `reply_to_message` and
  `forward_message` take no `from`, so an account whose login is not an email
  address and that has several identities needs `STALWART_EMAIL`.

## How it reaches Stalwart

Every tool hands a per-request credential to `bearerAuthorization`
(`src/jmap/session.ts`). The hosted server passes the client's OAuth token,
which becomes a Bearer header. The self-hosted server passes
`Basic base64(username:password)`, which goes through unchanged, to JMAP,
CalDAV, CardDAV and the attachment and upload routes alike. A hosted client
cannot reach the pass-through: its bearer is validated at Better Auth's
userinfo first, which rejects `Basic …`.

The process makes requests to `STALWART_URL` only: no Better Auth, no Auth
service, no `langmail.me` default. `src/self-hosted/self-hosted.test.ts`
records every `fetch` the server makes through startup, a mail search and a
contact search to show it; CalDAV goes through the same `fetch`. Two tools reach other hosts on the
user's request, as they do hosted: `preview_email` fetches a message's remote
images through the image proxy, and `unsubscribe_from_list` sends a sender's
one-click unsubscribe request.

## What the mode leaves out

The mode comes from the entrypoint (`McpHandlerConfig.mode`, `src/mode.ts`),
never from guessing at environment variables.

| Hosted | Self-hosted | Why |
|---|---|---|
| `share_calendar`, `stop_sharing_calendar`, the `/calendar-feeds/` route | Not offered; the route answers 404 | Shares live in Langmail's database, reached through Auth |
| Agent activity recorded per day | Not recorded | Same |
| `search_emails` `keywords` filter by classified type, `todo` among its values | No type filter; a `todo` boolean | No email-agent classifies the mail, so a type filter would always come back empty, which reads as "no such mail". `todo` is the flag `mark_emails` sets, not a type |
| Creating, updating or answering an event writes its attendees into a "Collected" address book | Off | It would create a book in someone's own Stalwart that their phone then syncs |
| Contact tools and instructions describe a book collected from mail headers and attendees | Worded without it; `search_contacts` reads every address book, and when no card matches, the From, To and Cc of the newest 50 messages whose headers match, outside Junk and Trash. People found there come back marked as not saved as a contact; nothing is written | That book does not exist there, so a person the user has only exchanged mail with has no card |
| `delete_contact` says `merge_contacts` keeps a contact's history | Says it keeps its addresses, phone numbers and notes | No interaction history is collected |

No self-hosted tool text names Langmail: a staged draft waits in the Drafts
folder for the user's mail app.

The hosted tool surface is pinned by `src/mcp/tool-surface.test.ts`; the
self-hosted instructions, and that no self-hosted tool names Langmail, are
checked by `src/mcp/instructions.test.ts`.

## Agent evals

`scripts/agent-eval-lib.ts` runs against the self-hosted server with a
Stalwart username and app password instead of a Langmail account
(`docs/evals.md`). `smoke-agent-self-hosted.ts` covers the self-hosted
requests: a search with no type filter, the to-do list, a drafted reply and an
unsubscribe the sender offers no one-click for, where the answer must not send
the user to Langmail. The evals that need no hosted-only feature run the same
way: `smoke-agent-forward`, `smoke-agent-preview`,
`smoke-agent-apple-mail-draft`, `smoke-agent-contact-role`,
`smoke-agent-contact-role-record`, `smoke-agent-triage-junk`, `smoke-agent-read-only` (at `--access
read-only`), `smoke-agent-no-send` (at `--access no-send`) and
`smoke-agent-windows-zone`,
which seeds its series over CalDAV with the eval library's credentials. The evals that
need a hosted-only feature test the hosted setup and live in
`langmail/platform`: the OAuth smoke test, calendar sharing, classified types
and collected contact history.
