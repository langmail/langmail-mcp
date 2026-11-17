# Langmail MCP for your own Stalwart: email, calendar and contacts

`langmail-mcp` is an open-source MCP server ([Model Context Protocol](https://modelcontextprotocol.io)) for people who run a self-hosted [Stalwart](https://stalw.art) mail server. It gives an AI agent the email, calendar and contacts tools of [Langmail](https://langmail.me)'s hosted MCP server, and works against your own Stalwart over JMAP, CalDAV and CardDAV. It runs on your computer or on your server and talks only to your Stalwart; no Langmail service is involved.

Not affiliated with Stalwart Labs.

> **The first release is pending.** `langmail-mcp` is not on npm yet, so `npx -y langmail-mcp` does not work today. Until it is, run the server from a clone: `git clone https://github.com/langmail/langmail-mcp.git`, `cd langmail-mcp`, `npm ci`, `npm run build`, and use `node /path/to/langmail-mcp/dist/index.js` wherever this document says `npx -y langmail-mcp`.

## What you can ask an agent to do with it

An agent connected to this server can search and read your mail, write drafts and send them, file and label messages, manage mail rules, and work with your calendars and contacts. The following prompts are examples of what that makes possible:

- "Find the email from the landlord about the heating repair. It was some time in 2023 and I cannot find it."
- "Summarise the conversation with the accountant about the tax return: what is done, what is still open, and what is waiting on my reply."
- "Draft a reply to Anna that proposes two free slots next week, and leave it in my drafts for me to review."

Reading mail does not mark it as read. Sending mail, unsubscribing and changing a meeting that other people are invited to cannot be undone, so it is sensible to have the agent confirm those with you first.

## Install

The server needs Node.js 22 or later. There is nothing to install by hand: an MCP client starts the server with `npx -y langmail-mcp`, which downloads the package on first use. To have the `langmail-mcp` command available permanently, for example on a server, install it globally:

```sh
npm install -g langmail-mcp
```

## Configure

All configuration comes from environment variables. The server checks them when it starts and refuses to start with a message that names what to set. Nothing has a default that points to a host other than your own.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `STALWART_URL` | yes | | Base URL of your Stalwart, for example `https://mail.example.com`. JMAP, CalDAV and CardDAV are reached under it. Use `https://`; the server warns about `http://` to any host but the local machine. |
| `STALWART_USERNAME` | with `STALWART_PASSWORD` | | The account's login name, usually its mail address. |
| `STALWART_PASSWORD` | with `STALWART_USERNAME` | | An app password for that account (see [Creating a Stalwart app password](#creating-a-stalwart-app-password)). |
| `STALWART_TOKEN` | instead of username and password | | A bearer token, for example a Stalwart API key. Set either this or the username and password, not both. |
| `MCP_TRANSPORT` | no | `stdio` | `stdio` or `http`. The command-line arguments `--http` and `--stdio` do the same and take precedence. |
| `MCP_AUTH_TOKEN` | in HTTP mode | | The secret callers must send as `Authorization: Bearer <secret>`. At least 16 printable ASCII characters without spaces. |
| `MCP_HOST` | no | `127.0.0.1` | HTTP mode: the address to listen on. |
| `MCP_PORT` | no | `8080` | HTTP mode: the port to listen on. |
| `MCP_PUBLIC_URL` | behind a reverse proxy | `http://<MCP_HOST>:<MCP_PORT>` | HTTP mode: the address callers reach the server under, for example `https://mcp.example.com`. |
| `LOG_LEVEL` | no | `warn` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. `info` adds one line per tool call. Logs go to stderr. |
| `LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST` | no | off | Set to `1` to let `unsubscribe_from_list` send a one-click unsubscribe request to the sender's URL. |
| `LANGMAIL_MCP_ALLOW_REMOTE_IMAGES` | no | off | Set to `1` to let `preview_email` load a message's remote images through this server. |

[`.env.example`](.env.example) lists the same settings with comments.

## Connect an agent

The server speaks MCP over two transports. Over **stdio**, the MCP client starts the server as a child process, which fits an agent that runs on the same computer. Over **Streamable HTTP**, the server runs on its own and the agent connects to it by URL, which fits an agent on a server.

### On the same computer, over stdio

Most MCP clients read a JSON configuration of this shape. The file's name and location depend on the client.

```json
{
	"mcpServers": {
		"langmail": {
			"command": "npx",
			"args": ["-y", "langmail-mcp"],
			"env": {
				"STALWART_URL": "https://mail.example.com",
				"STALWART_USERNAME": "you@example.com",
				"STALWART_PASSWORD": "your-app-password"
			}
		}
	}
}
```

For **Claude Desktop**, this is the content of `claude_desktop_config.json`, which opens from Settings, Developer, Edit Config. For **Claude Code**, one command adds the server:

```sh
claude mcp add langmail \
  -e STALWART_URL=https://mail.example.com \
  -e STALWART_USERNAME=you@example.com \
  -e STALWART_PASSWORD=your-app-password \
  -- npx -y langmail-mcp
```

The server does not contact Stalwart when it starts. A wrong URL or password therefore shows up on the agent's first tool call, not at start-up.

### On a server, over Streamable HTTP

In HTTP mode the server listens at `/mcp`, on `127.0.0.1:8080` by default. It refuses to start without `MCP_AUTH_TOKEN`, and every caller must send that secret as `Authorization: Bearer <token>`. Any other request to `/mcp` is answered with `401` and no data. `openssl rand -hex 32` generates a suitable secret.

```sh
export STALWART_URL=https://mail.example.com
export STALWART_USERNAME=you@example.com
export STALWART_PASSWORD=your-app-password
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
npx langmail-mcp --http
# langmail-mcp: listening on http://127.0.0.1:8080/mcp
```

`GET /healthz` answers `ok` without the token, for a process supervisor or a load balancer to check.

To keep the server running, a systemd unit along these lines can be used. The environment file holds the variables above, one `NAME=value` per line, and should be readable only by the service's user (`chmod 600`).

```ini
# /etc/systemd/system/langmail-mcp.service
[Unit]
Description=Langmail MCP for Stalwart
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/langmail-mcp.env
ExecStart=/usr/bin/npx -y langmail-mcp --http
Restart=on-failure
User=langmail-mcp

[Install]
WantedBy=multi-user.target
```

The default address is reachable from the same machine only, which is enough for an agent that runs on that machine. The server speaks plain HTTP. For that reason, TLS must be terminated by a reverse proxy before the server is exposed beyond loopback; otherwise the token and your mail travel unencrypted. With [Caddy](https://caddyserver.com), which obtains the certificate itself, the configuration is:

```
mcp.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

Behind a reverse proxy, `MCP_PUBLIC_URL` must be set to the address callers use, here `https://mcp.example.com`. The server only accepts requests addressed to a loopback name or to the host of `MCP_PUBLIC_URL`, as a protection against DNS rebinding, and answers `403` to a proxied request when the variable is missing. The links the attachment tools hand out are created under the same address.

A client then connects to a remote HTTP server with a bearer header. In Claude Code's `.mcp.json` format, which several other clients share:

```json
{
	"mcpServers": {
		"langmail": {
			"type": "http",
			"url": "https://mcp.example.com/mcp",
			"headers": {
				"Authorization": "Bearer your-mcp-auth-token"
			}
		}
	}
}
```

The equivalent Claude Code command is:

```sh
claude mcp add --transport http langmail https://mcp.example.com/mcp \
  --header "Authorization: Bearer your-mcp-auth-token"
```

There is no OAuth flow. A client that can only connect to remote servers through OAuth, and cannot send a fixed header, cannot use this server over HTTP.

## Creating a Stalwart app password

An **app password** is a separate password for one application, which can be revoked without changing the account's main password. Stalwart calls it by that name. Each user creates their own in Stalwart's account manager, which is served under `/account` on your Stalwart (for example `https://mail.example.com/account`). Stalwart shows the generated password once, so copy it when it is created. Stalwart's documentation describes the steps and the options: [App passwords](https://stalw.art/docs/auth/authentication/app-password/).

Set `STALWART_USERNAME` to the account's login name and `STALWART_PASSWORD` to the app password. The server signs in with HTTP Basic authentication. Alternatively, set `STALWART_TOKEN` to a Stalwart API key, which is sent as a bearer token.

## Tools

The server registers 40 tools. Their names, inputs and descriptions are the same as on Langmail's hosted server, so the Langmail documentation describes what each one does and how they fit together: <https://docs.langmail.me/reference/mcp/overview>.

| Group | Tools |
| --- | --- |
| Mail | `search_emails`, `get_email`, `get_thread`, `preview_email`, `archive_emails`, `move_emails`, `trash_emails`, `mark_emails`, `unsubscribe_from_list` |
| Drafts and sending | `create_draft`, `get_draft`, `list_drafts`, `update_draft`, `delete_draft`, `send_draft`, `reply_to_message`, `forward_message` |
| Attachments | `download_attachment`, `download_email`, `upload_attachments` |
| Mail rules | `preview_mail_rule`, `create_mail_rule`, `list_mail_rules`, `update_mail_rule`, `delete_mail_rule` |
| Calendar | `list_calendars`, `create_calendar`, `update_calendar`, `list_calendar_events`, `create_calendar_event`, `update_calendar_event`, `delete_calendar_event`, `move_calendar_events`, `respond_to_event` |
| Contacts | `search_contacts`, `list_upcoming_birthdays`, `create_contact`, `update_contact`, `delete_contact`, `merge_contacts` |

## Differences from Langmail's hosted server

The tools behave as they do on the hosted server wherever a plain Stalwart allows it. The differences below follow from two facts: this server has no Langmail service behind it, and it sends nothing to a third party unless you turn that on.

- **Calendar sharing is left out.** `share_calendar` and `stop_sharing_calendar` hand out calendar feed links that Langmail's hosted service and database serve. This server has neither, so the two tools do not exist here, and `list_calendars` shows no sharing information.
- **One-click unsubscribe is off by default.** The one-click request of RFC 8058 goes to a URL the sender chose. `unsubscribe_from_list` sends it only when `LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST=1` is set. Otherwise the tool returns the unsubscribe link or address for you to use yourself.
- **Remote images are not loaded by default.** `preview_email` renders a message without its remote images unless `LANGMAIL_MCP_ALLOW_REMOTE_IMAGES=1` is set. When it is, this server fetches the images and passes them on, so the sender sees the server's address and not the address of the device that shows the preview.
- **Attachment links are served by this server.** `download_attachment`, `download_email` and `upload_attachments` hand out short-lived URLs. In HTTP mode they are under `MCP_PUBLIC_URL`. In stdio mode the server listens on a local port on `127.0.0.1` for them, so they only work on the same computer.
- **The `type` filter and to-do labels need classification keywords.** Langmail's hosted classifier writes keywords onto messages, and the `type` filter of `search_emails` and the to-do labels rely on them. On a plain Stalwart mailbox those filters match nothing unless something else sets the keywords. Search by text, sender, date, folder, read state and star works as usual.
- **Contacts are not collected from mail.** Hosted Langmail collects the people you correspond with from mail headers in a background service, which this server does not have. The Collected address book grows only from the calendar tools, i.e. from the people you schedule with or reply to an invitation from. Contacts that you or the agent create, and anything synced over CardDAV, work the same.
- **You sign in with your own Stalwart login.** The hosted server uses Langmail's OAuth. This server uses an app password or a bearer token for your Stalwart account.

## Privacy: what leaves your machine

The server's invariant is that nothing leaves your computer or server except traffic to your own Stalwart, unless you turn it on. Two settings turn something on, and both default to off: `LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST` (a request to a sender's unsubscribe URL) and `LANGMAIL_MCP_ALLOW_REMOTE_IMAGES` (requests to the hosts a message's images are on). There is no telemetry, no error reporting service and no update check. Logs go to stderr only and carry neither credentials nor message content.

However, this covers the server and not the agent. Whatever a tool returns goes to the MCP client that asked for it, and from there to the model that client uses. If that model runs at a provider, the mail the agent reads passes through that provider.

## Requirements

- Node.js 22 or later.
- A Stalwart server with an account you can sign in to. The server is tested end-to-end in CI against a real Stalwart at the version in [`.stalwart-version`](.stalwart-version), currently 1.1.1. Other versions may work but are not tested.

## Development

```sh
git clone https://github.com/langmail/langmail-mcp.git
cd langmail-mcp
npm ci
cp .env.example .env   # then fill in your own values
npm run dev            # runs src/index.ts with .env, restarting on changes
```

`npm run build` compiles to `dist/`, `npm test` runs the unit tests, and `npm run check:fix` formats and lints with Biome. `npm run validate` runs everything CI checks except the end-to-end suites: lint, unit tests, unused-code check and build. `npm run test:e2e` runs the suites in `e2e/` against a real Stalwart; [`e2e/README.md`](e2e/README.md) describes how to start one locally, with or without docker.

## Contributing, security and license

Contributions are welcome; [CONTRIBUTING.md](CONTRIBUTING.md) describes the workflow and the commit convention, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies. Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue. The code is released under the [MIT license](LICENSE).
