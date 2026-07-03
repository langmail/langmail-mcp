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
- Structured search over the authenticated user's mailbox — free-text combined with date-range, sender, category-label, and mailbox filters
- Read a single message's full body, or every message in a thread
- List and create the user's calendars
- List, create, update, and delete calendar events — including recurring series — sending iMIP invitations and cancellations to attendees
- RSVP to invitations (accept / decline / tentative), notifying the organizer automatically

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

### Tests

`bun test` runs the unit suite. The CalDAV adapter also has integration
tests that drive the real client against a live CalDAV server; they skip
unless `CALDAV_BASE_URL` / `CALDAV_USERNAME` / `CALDAV_PASSWORD` are set. CI
runs them against a throwaway [Radicale](https://radicale.org) instance (see
the `CalDAV Integration (mcp)` job in
`.github/workflows/test-caldav.yml`). To run them locally, start any CalDAV
server and point the env at it:

```bash
pip install radicale
printf 'test:test\n' > /tmp/radicale-users
radicale --auth-type htpasswd --auth-htpasswd-filename /tmp/radicale-users \
  --auth-htpasswd-encryption plain --storage-filesystem-folder /tmp/radicale &
CALDAV_BASE_URL=http://127.0.0.1:5232 CALDAV_USERNAME=test CALDAV_PASSWORD=test \
  bun run test:integration
```

## Available Tools

### search_emails

Structured search over the authenticated user's mailbox. Combine free-text
full-text search with any of the optional filters below; at least one filter
is required. Returns a token-frugal hit list (no bodies) newest-first — fetch
a full message with `get_email`.

Parameters (at least one of `query`, `after`, `before`, `from`, `keywords`, or `mailbox` is required):
- `query`: string (optional) — free-text full-text search over subject and body (1–500 characters)
- `after`: string (optional) — only messages received on/after this UTC ISO-8601 timestamp (e.g. `2026-04-01T00:00:00Z`)
- `before`: string (optional) — only messages received strictly before this UTC ISO-8601 timestamp
- `from`: string (optional) — substring match on the sender name or address (1–200 characters)
- `keywords`: array of string (optional) — category labels to filter by (combined with OR); values come from the classification taxonomy
- `mailbox`: string (optional) — restrict to a named mailbox/folder (e.g. `Inbox`)
- `limit`: number (optional) — maximum results, 1–100 (default 20)

Returns:
- A list of matching messages newest-first, each with its id, subject, sender, date, and tags

### get_email

Fetches a single message's recipients and plain-text body by id. `search_emails`
and `get_thread` deliberately omit bodies; open a specific hit with this tool.

Parameters:
- `id`: string — the message id, as returned by `search_emails` or `get_thread`

Returns:
- The message's subject, sender, recipients, date, tags, and plain-text body

### get_thread

Lists every message in the same thread as a given message id, oldest-first, in
the lightweight search-result shape. Fetch a body with `get_email`.

Parameters:
- `id`: string — a message id; every message in its thread is returned

Returns:
- A list of the thread's messages oldest-first, each with its id, subject, sender, date, and tags

### list_calendars

Lists the authenticated user's calendars, returning each calendar's display
name and CalDAV URL. Pass the URL to `create_calendar_event` to target a
specific calendar.

Parameters: none

Returns:
- A list of the user's calendars, each with its display name and CalDAV URL

### create_calendar

Creates a new calendar (CalDAV collection) for the authenticated user — e.g.
a separate "Marketing" calendar so a workstream's events don't clutter the
personal one. Returns the new calendar's CalDAV URL; pass it to
`create_calendar_event` to add events to it.

Parameters:
- `name`: string — the calendar's display name (1–200 characters)
- `color`: string (optional) — a hex display color (e.g. `#FF6600`), carried through the Apple `calendar-color` extension so the calendar is visually distinct

Returns:
- A confirmation including the new `calendarUrl` (pass it to `create_calendar_event`)

### list_calendar_events

Lists events in the user's calendar, optionally bounded by a time window.
Use the returned `uid` to target `update_calendar_event` or
`delete_calendar_event`.

Parameters:
- `calendarUrl`: string (optional) — a CalDAV URL from `list_calendars`; defaults to the user's default calendar
- `start`: string (optional) — window start (ISO 8601 with offset); must be paired with `end`
- `end`: string (optional) — window end (ISO 8601 with offset); must be paired with `start`

Returns:
- A list of events, each with its title, time, location (if any), repeat rule (for recurring events), and `uid`

### create_calendar_event

Creates a calendar event and sends iMIP invitations to the attendees, with
the authenticated user as organizer. Pass `recurrence` to create a repeating
series in a single call.

Parameters:
- `title`: string — event title (1–200 characters)
- `start`: string — start datetime (ISO 8601 with offset, e.g. `2026-06-12T10:00:00Z`)
- `end`: string — end datetime (ISO 8601 with offset); must be after `start`
- `attendees`: array of string — 1–50 attendee email addresses
- `calendarUrl`: string (optional) — a CalDAV URL from `list_calendars`; defaults to the user's default calendar
- `description`: string (optional) — up to 5000 characters
- `location`: string (optional) — up to 500 characters
- `recurrence`: string or object (optional) — turns the event into a repeating series; either a raw iCalendar RRULE (e.g. `FREQ=WEEKLY;BYDAY=TH`) or a structured object `{frequency, interval?, byDay?, until?|count?}`. `start`/`end` describe the first occurrence

Returns:
- A confirmation that the event was created and invitations were sent, including the event `uid` and `calendarUrl` (pass these to `update_calendar_event` / `delete_calendar_event`)

### update_calendar_event

Updates an existing event in place (identified by its `uid`) and re-sends
iMIP notifications to the attendees. This is a full replacement — pass the
complete event details, not just the changed fields. For a recurring event
this edits the entire series: pass `recurrence` again to keep it recurring;
omitting it collapses the series back to a single event. (Editing a single
occurrence of a series is not supported.)

Parameters:
- `uid`: string — the event's iCalendar UID, from `create_calendar_event` or `list_calendar_events`
- `title`: string — event title (1–200 characters)
- `start`: string — start datetime (ISO 8601 with offset)
- `end`: string — end datetime (ISO 8601 with offset); must be after `start`
- `attendees`: array of string — 1–50 attendee email addresses
- `calendarUrl`: string (optional) — a CalDAV URL from `list_calendars`; defaults to the user's default calendar
- `description`: string (optional) — up to 5000 characters
- `location`: string (optional) — up to 500 characters
- `recurrence`: string or object (optional) — same shape as `create_calendar_event`; re-rules the whole series (omit to make it a one-off)

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

### respond_to_event

RSVPs to a calendar invite on the authenticated user's behalf: sets their own
attendee status to accept, decline, or tentative on the event and saves it
back. The organizer is notified automatically. Use this to reply to an
invitation you received; it does not change the event itself.

Parameters:
- `uid`: string — the event's iCalendar UID, from `list_calendar_events`
- `response`: string — one of `accept`, `decline`, or `tentative`
- `calendarUrl`: string (optional) — a CalDAV URL from `list_calendars`; defaults to the user's default calendar

Returns:
- A confirmation of the RSVP (including the event title when available)
