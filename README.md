# langmail-mcp

<div align="center">

📬 A Model Context Protocol (MCP) server that exposes a Langmail user's email and calendar as tools for AI assistants.

[![Deploy](https://github.com/langmail/platform/actions/workflows/deploy-mcp.yml/badge.svg)](https://github.com/langmail/platform/actions/workflows/deploy-mcp.yml)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)
[![Bun](https://img.shields.io/badge/Bun-runtime-black.svg?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

</div>

## ✨ Features

- Speaks the Streamable HTTP transport over `/mcp`
- Authenticates clients via OAuth 2.0 — advertises its own authorization metadata and proxies dynamic client registration to Stalwart
- Full-text search over the authenticated user's mailbox
- List the user's calendars
- Create calendar events and send iMIP invitations to attendees

The public endpoint is `https://mcp.langmail.me/mcp`.

## Setup

Add the server as a remote (HTTP) MCP server in Claude Code:

```sh
claude mcp add --transport http langmail https://mcp.langmail.me/mcp
```

The first time you use it, Claude Code runs the OAuth flow: it opens a
browser to sign in to your Langmail account and authorize access. You can
re-trigger or inspect this anytime with the `/mcp` command inside Claude
Code.

Verify the connection and list the exposed tools:

```sh
claude mcp list
```

For other MCP clients, point them at `https://mcp.langmail.me/mcp` using the
Streamable HTTP transport and complete the OAuth flow they prompt for.

## Development

This service is **Bun-only** — there is no Node fallback.

### Quick Start

Run the MCP server in development mode:

```bash
bun run dev
```

This serves the endpoint on `http://127.0.0.1:8080/mcp`. Point a client at
the local URL instead of production:

```sh
claude mcp add --transport http langmail-local http://127.0.0.1:8080/mcp
```

### Type Check

The build gate is a type check only — the container runs TypeScript from
source, so there is no compile or bundle step:

```bash
bun run build
```

## Available Tools

### search_emails

Full-text search over the authenticated user's mailbox. Returns matching
messages with subject, sender, and date.

Parameters:
- `query`: string — search text (1–500 characters)
- `mailbox`: string (optional) — restrict the search to a named mailbox
- `limit`: number (optional) — maximum results, 1–100 (default 20)

Returns:
- A list of matching messages, each with its subject, sender, and date

### list_calendars

Lists the authenticated user's calendars, returning each calendar's display
name and CalDAV URL. Pass the URL to `create_calendar_event` to target a
specific calendar.

Parameters: none

Returns:
- A list of the user's calendars, each with its display name and CalDAV URL

### create_calendar_event

Creates a calendar event and sends iMIP invitations to the attendees, with
the authenticated user as organizer.

Parameters:
- `title`: string — event title (1–200 characters)
- `start`: string — start datetime (ISO 8601 with offset, e.g. `2026-06-12T10:00:00Z`)
- `end`: string — end datetime (ISO 8601 with offset); must be after `start`
- `attendees`: array of string — 1–50 attendee email addresses
- `calendarUrl`: string (optional) — a CalDAV URL from `list_calendars`; defaults to the user's default calendar
- `description`: string (optional) — up to 5000 characters
- `location`: string (optional) — up to 500 characters

Returns:
- A confirmation that the event was created and invitations were sent
</content>
</invoke>
