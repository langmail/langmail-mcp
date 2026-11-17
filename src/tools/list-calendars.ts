// list_calendars tool — returns the authenticated principal's calendars
// (display name, CalDAV URL, and color) via RFC 6764 discovery.
//
// The hosted tool also names who each calendar is shared with. This server has
// no calendar sharing (no share_calendar, no stop_sharing_calendar), so a
// calendar's entry carries no sharing line at all.
//
// Like search-emails.ts, the logic sits behind a `Deps` interface so it
// unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { type CalDavConfig, fetchCalendarList } from "../caldav/client.ts";
import type { CalendarSummary } from "../caldav/types.ts";
import { READ_ONLY } from "./annotations.ts";
import { type ToolResult, textResult } from "./result.ts";

// No inputs: the principal is implied by the bearer.
const listCalendarsInput = z.object({});

export interface ListCalendarsDeps {
	listCalendars: (token: string) => Promise<CalendarSummary[]>;
}

export interface ListCalendarsContext {
	token: string;
}

const formatCalendar = (idx: number, cal: CalendarSummary): string =>
	`${idx}. ${cal.displayName || "(unnamed)"}\n   url: ${cal.url}${cal.color ? `\n   color: ${cal.color}` : ""}`;

export const listCalendars = async (
	deps: ListCalendarsDeps,
	ctx: ListCalendarsContext
): Promise<ToolResult> => {
	const calendars = await deps.listCalendars(ctx.token);
	if (calendars.length === 0) {
		return textResult("No calendars found.");
	}
	const lines = calendars.map((c, i) => formatCalendar(i + 1, c));
	return textResult(
		`${calendars.length} calendar(s):\n\n${lines.join("\n\n")}`
	);
};

export const makeLiveDeps = (cfg: CalDavConfig): ListCalendarsDeps => ({
	listCalendars: (token) => fetchCalendarList(cfg, token),
});

// --- MCP registration ----------------------------------------------------

export const registerListCalendars = (
	server: McpServer,
	deps: ListCalendarsDeps,
	// Bearer threaded per request — see mcp/handler.ts.
	getToken: () => string
): void => {
	server.registerTool(
		"list_calendars",
		{
			annotations: READ_ONLY,
			description:
				"Lists the authenticated user's calendars — the calendars themselves, not the events on them. " +
				"Use this to see which calendars exist before adding an event to a specific one, or to find the " +
				"calendar to rename or recolor. Returns each " +
				"calendar’s name, CalDAV URL and color when it has one; the URL is what create_calendar_event, " +
				"update_calendar and move_calendar_events take. " +
				"For the events on a calendar use list_calendar_events; to rename or recolor one use " +
				"update_calendar; to move events onto one use move_calendar_events.",
			inputSchema: listCalendarsInput,
			title: "List calendars",
		},
		() => listCalendars(deps, { token: getToken() })
	);
};
