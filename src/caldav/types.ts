// Minimal CalDAV shapes used by the calendar tools.
//
// Like src/jmap/types.ts, this declares only what the tools read or send —
// the tsdav DAVCalendar/DAVAccount types stay behind caldav/client.ts.

// A calendar collection as surfaced to the agent: a human label and the
// CalDAV URL used to address it (e.g. when PUTting an event).
export interface CalendarSummary {
	// Apple `calendar-color` hex (e.g. "#FF6600"), when the server has one.
	color?: string;
	displayName: string;
	url: string;
}

// A single stored calendar object (`.ics`) as fetched from the server:
// its CalDAV URL, the current ETag (for conditional update/delete), and
// the raw iCalendar payload.
export interface CalendarObject {
	data: string;
	etag?: string;
	url: string;
}

// Result of RFC 6764 discovery for the authenticated principal.
export interface DiscoveredAccount {
	calendars: CalendarSummary[];
	// The calendar an event lands in when the caller doesn't pick one.
	defaultCalendarUrl: string | null;
	// The principal's calendar-user-address (bare email, no `mailto:`),
	// used as the VEVENT ORGANIZER so Stalwart can fan out the invite.
	organizer: string | null;
}
