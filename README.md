# Langmail MCP server

An [MCP](https://modelcontextprotocol.io) resource server that exposes a
Langmail user's email and calendar to MCP clients. It speaks the
Streamable HTTP transport over `/mcp` and authenticates clients via
OAuth 2.0 (the server advertises its own authorization metadata and
proxies dynamic client registration to Stalwart).

The public endpoint is `https://mcp.langmail.me/mcp`. For local
development, `bun run dev` serves it on `http://127.0.0.1:8080/mcp`.

## Use with Claude Code

Add the server as a remote (HTTP) MCP server:

```sh
claude mcp add --transport http langmail https://mcp.langmail.me/mcp
```

The first time you use it, Claude Code runs the OAuth flow: it opens a
browser to sign in to your Langmail account and authorize access. You
can re-trigger or inspect this anytime with the `/mcp` command inside
Claude Code.

To point at a locally running server instead, swap the URL:

```sh
claude mcp add --transport http langmail-local http://127.0.0.1:8080/mcp
```

Verify the connection and list the exposed tools:

```sh
claude mcp list
```

## Available tools

| Tool                    | Description                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `search_emails`         | Full-text search over the authenticated user's mailbox. Returns matching messages with subject, sender, and date. Optional `mailbox` filter and `limit` (1–100, default 20). |
| `list_calendars`        | Lists the authenticated user's calendars, returning each calendar's display name and CalDAV URL. Pass the URL to `create_calendar_event` to target a specific calendar. |
| `create_calendar_event` | Creates a calendar event and sends iMIP invitations to the attendees, with the authenticated user as organizer. Times are ISO 8601 with offset; optionally pass a CalDAV URL from `list_calendars` to target a specific calendar, otherwise defaults to the user's default calendar. |
