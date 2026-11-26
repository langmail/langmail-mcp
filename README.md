# langmail-mcp

An MCP server that gives an AI agent the mail, calendar and contacts of one
mailbox on your own [Stalwart](https://stalw.art) server. It talks to Stalwart
over JMAP, CalDAV and CardDAV, with a username and an app password, and needs
no other service.

This is the server Langmail runs at `mcp.langmail.me`, from the same code. The
hosted server adds a few features that need Langmail's own services, listed
under [Hosted and self-hosted](#hosted-and-self-hosted).

## Let your agent decide if this is for you

```sh
I found this project on GitHub: https://github.com/langmail/langmail-mcp
Is this something useful for my setup regarding MCP access to emails, calendars, and contacts?
How does it compare to what we're currently using.
```

## What your agent can do with it

- **Mail:** search, read whole conversations, file, mark, archive and trash
  messages, download attachments, preview a message as a rendered page and
  unsubscribe from mailing lists.
- **Writing:** stage drafts with attachments, then send them, reply or
  forward. A staged draft waits in the Drafts folder, so you can also review
  and send it from your mail app.
- **Calendar:** list calendars and events, create, update, move and delete
  events, and answer invitations.
- **Contacts:** search the address books, create, update, merge and delete
  contacts, and list upcoming birthdays.
- **Mail rules:** list, preview, create, update and delete the Sieve rules that
  file incoming mail.

The [tool reference](https://docs.langmail.me/reference/mcp/overview)
describes every tool. It is written for the hosted server, and the
differences are in [`docs/self-hosted.md`](docs/self-hosted.md).

## Start it

You need Node 22.12 or later (not 23) or Bun, a Stalwart account and an app
password for it.

On the same computer as the agent, the MCP client starts the server and talks
to it over stdio:

```sh
STALWART_URL=https://mail.example.com STALWART_USERNAME=alice \
  STALWART_PASSWORD=<app password> npx langmail-mcp
```

Over the network, the server listens for Streamable HTTP and every request
must carry the secret you set:

```sh
STALWART_URL=https://mail.example.com STALWART_USERNAME=alice \
  STALWART_PASSWORD=<app password> MCP_AUTH_TOKEN=<long random secret> \
  npx langmail-mcp --transport http --host 0.0.0.0 --port 8080
```

Under Bun, use `bunx --bun langmail-mcp`. `langmail-mcp --help` lists every
setting with its variable.

### Connect an MCP client

Claude Code, over stdio:

```sh
claude mcp add langmail \
  --env STALWART_URL=https://mail.example.com \
  --env STALWART_USERNAME=alice \
  --env STALWART_PASSWORD=<app password> \
  -- npx -y langmail-mcp
```

A client configured with JSON, such as Claude Desktop:

```json
{
  "mcpServers": {
    "langmail": {
      "command": "npx",
      "args": ["-y", "langmail-mcp"],
      "env": {
        "STALWART_URL": "https://mail.example.com",
        "STALWART_USERNAME": "alice",
        "STALWART_PASSWORD": "<app password>"
      }
    }
  }
}
```

## Settings

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `STALWART_URL` | `--stalwart-url` | required | Stalwart's base URL; JMAP, CalDAV and CardDAV are reached under it |
| `STALWART_USERNAME` | `--username` | required | The account name to sign in with |
| `STALWART_PASSWORD` | none | required | An app password for that account |
| `STALWART_EMAIL` | `--email` | the login Stalwart reports | The address to send mail as |
| `MCP_ACCESS` | `--access` | `everything` | What the agent may do: `read-only`, `no-send` or `everything` ([access levels](docs/reference/mcp/overview.mdx#access-levels)) |
| `MCP_TRANSPORT` | `--transport` | `stdio` | `stdio` or `http` (Streamable HTTP) |
| `MCP_HOST` | `--host` | `127.0.0.1` | Where the HTTP listener binds |
| `MCP_PORT` | `--port` | `8080` for http | The HTTP listener's port |
| `MCP_PUBLIC_URL` | `--public-url` | `http://<host>:<port>` | Base URL for the attachment and image links the server creates |
| `MCP_AUTH_TOKEN` | none | required for http | The bearer every `/mcp` request must carry |

The secrets have no flag, because a flag shows in the process list. What each
setting does, the checks at startup and what the server sends where:
[`docs/self-hosted.md`](docs/self-hosted.md).

## Hosted and self-hosted

| Feature | Hosted at `mcp.langmail.me` | Self-hosted |
|---|---|---|
| Sign-in | OAuth with a Langmail account | Stalwart username and app password |
| Calendar sharing (`share_calendar`, `stop_sharing_calendar`) | Yes | No |
| Filter mail by classified type | Yes | No; a `todo` flag instead |
| Address book collected from mail and invitations | Yes | No; `search_contacts` also looks at recent mail headers |

The details and reasons are in [`docs/self-hosted.md`](docs/self-hosted.md)
§ What the mode leaves out.

## Development

```sh
git clone https://github.com/langmail/langmail-mcp.git
cd langmail-mcp
bun install
bun test
```

`CONTRIBUTING.md` covers the checks, the integration tests against Radicale
and a dev Stalwart, and how releases work. `docs/evals.md` covers the agent
evals. Report bugs in [GitHub issues](https://github.com/langmail/langmail-mcp/issues)
and vulnerabilities as `SECURITY.md` describes.

## License

[MIT](LICENSE)
