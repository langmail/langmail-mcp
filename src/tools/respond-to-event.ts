// respond_to_event tool — RSVP to a calendar invite (accept / decline /
// tentative) by setting the authenticated user's own ATTENDEE PARTSTAT on the
// stored VEVENT and PUTting it back to the same CalDAV object.
//
// In production, Stalwart's CalDAV scheduling (RFC 6638) sends the iTIP
// METHOD:REPLY to the organizer automatically when an attendee updates their
// calendar copy, so we do not construct the reply ourselves. We only flip our
// own PARTSTAT and leave SEQUENCE (the organizer's) untouched.
//
// Logic sits behind a `Deps` interface (discover + fetchEvent + updateEvent)
// so it unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type CalDavConfig,
	discoverAccount,
	type FetchEventParams,
	fetchEvent,
	resolveCalendarUrl,
	type UpdateEventParams,
	updateEvent,
} from "../caldav/client.ts";
import { type Partstat, setAttendeePartstat } from "../caldav/rsvp.ts";
import type { CalendarObject, DiscoveredAccount } from "../caldav/types.ts";
import { parseEvents } from "../ical/index.ts";
import { OUTWARD_WRITE } from "./annotations.ts";
import type { AttendeeWriteThrough } from "./contact-write-through.ts";
import { eventUidSchema } from "./create-calendar-event.ts";
import { errorResult, type ToolResult, textResult } from "./result.ts";

export const respondToEventInput = z.object({
	// Optional CalDAV URL from list_calendars; defaults to the principal's
	// discovered default calendar (where create_calendar_event also lands).
	calendarUrl: z.url().optional(),
	response: z.enum(["accept", "decline", "tentative"]),
	uid: eventUidSchema,
});

export type RespondToEventArgs = z.infer<typeof respondToEventInput>;

type Response = RespondToEventArgs["response"];

// Friendly response names → the RFC 5545 PARTSTAT we write.
const PARTSTAT_BY_RESPONSE: Record<Response, Partstat> = {
	accept: "ACCEPTED",
	decline: "DECLINED",
	tentative: "TENTATIVE",
};

// …and → the past-tense word used in the confirmation message.
const CONFIRMATION_BY_RESPONSE: Record<Response, string> = {
	accept: "accepted",
	decline: "declined",
	tentative: "tentatively",
};

export interface RespondToEventDeps {
	// Upserts the event's organizer and attendees into the collected address
	// book after a successful RSVP (never throws — see contact-write-through.ts).
	// Covers invitations whose organizer address only lives in the event.
	collectAttendees?: AttendeeWriteThrough;
	discover: (token: string) => Promise<DiscoveredAccount>;
	fetchEvent: (params: FetchEventParams) => Promise<CalendarObject | null>;
	updateEvent: (params: UpdateEventParams) => Promise<void>;
}

export interface RespondToEventContext {
	args: RespondToEventArgs;
	token: string;
}

export const respondToEvent = async (
	deps: RespondToEventDeps,
	ctx: RespondToEventContext
): Promise<ToolResult> => {
	const { args, token } = ctx;
	const account = await deps.discover(token);

	// discoverAccount surfaces the principal's calendar-user-address as
	// `organizer`; for an RSVP it doubles as the ATTENDEE address we match on.
	if (!account.organizer) {
		return errorResult("Could not determine your address for this account.");
	}
	const attendeeEmail = account.organizer;

	const resolved = resolveCalendarUrl(account, args.calendarUrl);
	if (!resolved.ok) {
		return errorResult(
			resolved.reason === "none"
				? "No calendar available to respond in."
				: `Calendar not found: ${args.calendarUrl}`
		);
	}
	const calendarUrl = resolved.url;

	const existing = await deps.fetchEvent({ calendarUrl, token, uid: args.uid });
	if (!existing) {
		return errorResult(`Event not found: ${args.uid}`);
	}

	const result = setAttendeePartstat(
		existing.data,
		attendeeEmail,
		PARTSTAT_BY_RESPONSE[args.response]
	);
	if (!result.ok) {
		return errorResult(
			"You are not an attendee of this event, so you can't RSVP."
		);
	}

	await deps.updateEvent({
		ical: result.ical,
		token,
		url: existing.url,
		...(existing.etag ? { etag: existing.etag } : {}),
	});

	const event = parseEvents(existing.data).find((e) => e.uid === args.uid);
	if (event) {
		await deps.collectAttendees?.({
			attendees: event.attendees,
			// Only an acceptance confirms the pairing; declining or tentatively
			// answering a cold invite must not promote a stranger's address.
			kind: args.response === "accept" ? "action" : "observed",
			selfAddress: attendeeEmail,
			start: event.start,
			token,
			uid: args.uid,
			...(event.organizer ? { organizer: event.organizer } : {}),
		});
	}
	return textResult(
		`RSVP'd ${CONFIRMATION_BY_RESPONSE[args.response]}${event?.title ? ` to "${event.title}"` : ""}.`
	);
};

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (
	cfg: CalDavConfig,
	collectAttendees?: AttendeeWriteThrough
): RespondToEventDeps => ({
	discover: (token) => discoverAccount(cfg, token),
	fetchEvent: (params) => fetchEvent(cfg, params),
	updateEvent: (params) => updateEvent(cfg, params),
	...(collectAttendees ? { collectAttendees } : {}),
});

// --- MCP registration ----------------------------------------------------

export const registerRespondToEvent = (
	server: McpServer,
	deps: RespondToEventDeps,
	// Bearer threaded per request — see mcp/handler.ts.
	getToken: () => string
): void => {
	server.registerTool(
		"respond_to_event",
		{
			annotations: OUTWARD_WRITE,
			description:
				"RSVP to a calendar invite or meeting invitation on the authenticated user’s behalf — accept, " +
				"decline, or answer tentative/maybe. Sets their " +
				"own attendee status on the event " +
				"(identified by its uid from list_calendar_events) and saves it back. The " +
				"organizer is notified automatically. Use this to reply to an invitation you " +
				"received; it does not change the event itself. Defaults to the user’s default " +
				"calendar; pass calendarUrl if the event lives in another calendar.",
			inputSchema: respondToEventInput,
			title: "Respond to calendar event",
		},
		(args) => {
			const parsed = respondToEventInput.parse(args);
			return respondToEvent(deps, { args: parsed, token: getToken() });
		}
	);
};
