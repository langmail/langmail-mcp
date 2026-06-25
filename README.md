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
- List, create, update, and delete calendar events — sending iMIP invitations and cancellations to attendees

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

### list_calendar_events

Lists events in the user's calendar, optionally bounded by a time window.
Use the returned `uid` to target `update_calendar_event` or
`delete_calendar_event`.

Parameters:
- `calendarUrl`: string (optional) — a CalDAV URL from `list_calendars`; defaults to the user's default calendar
- `start`: string (optional) — window start (ISO 8601 with offset); must be paired with `end`
- `end`: string (optional) — window end (ISO 8601 with offset); must be paired with `start`

Returns:
- A list of events, each with its title, time, location (if any), and `uid`

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
- A confirmation that the event was created and invitations were sent, including the event `uid` and `calendarUrl` (pass these to `update_calendar_event` / `delete_calendar_event`)

### update_calendar_event

Updates an existing event in place (identified by its `uid`) and re-sends
iMIP notifications to the attendees. This is a full replacement — pass the
complete event details, not just the changed fields.

Parameters:
- `uid`: string — the event's iCalendar UID, from `create_calendar_event` or `list_calendar_events`
- `title`: string — event title (1–200 characters)
- `start`: string — start datetime (ISO 8601 with offset)
- `end`: string — end datetime (ISO 8601 with offset); must be after `start`
- `attendees`: array of string — 1–50 attendee email addresses
- `calendarUrl`: string (optional) — a CalDAV URL from `list_calendars`; defaults to the user's default calendar
- `description`: string (optional) — up to 5000 characters
- `location`: string (optional) — up to 500 characters

Returns:
- A confirmation that the event was updated and notifications were sent

### delete_calendar_event

Deletes an event (identified by its `uid`); the server sends iMIP
cancellations to any attendees.

Parameters:
- `uid`: string — the event's iCalendar UID, from `create_calendar_event` or `list_calendar_events`
- `calendarUrl`: string (optional) — a CalDAV URL from `list_calendars`; defaults to the user's default calendar

Returns:
- A confirmation that the event was deleted
