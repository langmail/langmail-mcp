import { describe, expect, test } from "vitest";

import { parseEvents } from "./ical-parse.ts";

// Hand-rolled VEVENT fixture. The real invite writer (ical-generator) lives
// in src/caldav — its ical-roundtrip test covers writer↔parser fidelity —
// so these tests stay dependency-free. Values are raw content
// lines: pre-escape TEXT values (`\\;`) exactly as a server would emit them.
interface FixtureInvite {
	attendees?: string[];
	description?: string;
	end?: string;
	location?: string;
	rrule?: string;
	start?: string;
	title?: string;
	uid?: string;
}

const invite = (over: FixtureInvite = {}): string =>
	[
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"BEGIN:VEVENT",
		`UID:${over.uid ?? "evt-1@example.com"}`,
		`SUMMARY:${over.title ?? "Sync"}`,
		`DTSTART:${over.start ?? "20260612T100000Z"}`,
		`DTEND:${over.end ?? "20260612T103000Z"}`,
		"ORGANIZER:mailto:host@example.com",
		...(over.attendees ?? ["guest@example.com"]).map(
			(a) => `ATTENDEE;RSVP=TRUE:mailto:${a}`
		),
		...(over.location ? [`LOCATION:${over.location}`] : []),
		...(over.description ? [`DESCRIPTION:${over.description}`] : []),
		...(over.rrule ? [`RRULE:${over.rrule}`] : []),
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");

const sample = invite({ description: "Quarterly review", location: "Room 4" });

describe("parseEvents", () => {
	test("extracts uid, title, ISO times, and location from a built invite", () => {
		const [ev, ...rest] = parseEvents(sample);
		expect(rest).toHaveLength(0);
		expect(ev?.uid).toBe("evt-1@example.com");
		expect(ev?.title).toBe("Sync");
		expect(ev?.start).toBe("2026-06-12T10:00:00Z");
		expect(ev?.end).toBe("2026-06-12T10:30:00Z");
		expect(ev?.location).toBe("Room 4");
	});

	test("extracts the RRULE of a recurring event", () => {
		const ics = invite({
			rrule: "FREQ=WEEKLY;BYDAY=TH",
			title: "Weekly sync",
			uid: "evt-r@example.com",
		});
		expect(parseEvents(ics)[0]?.recurrence).toBe("FREQ=WEEKLY;BYDAY=TH");
	});

	test("omits recurrence for a one-off event", () => {
		expect(parseEvents(sample)[0]?.recurrence).toBeUndefined();
	});

	test("trims trailing whitespace a server may emit on the RRULE line", () => {
		const ics =
			"BEGIN:VEVENT\r\nUID:evt-w@example.com\r\nRRULE:FREQ=WEEKLY \r\nEND:VEVENT";
		expect(parseEvents(ics)[0]?.recurrence).toBe("FREQ=WEEKLY");
	});

	test("omits location when absent", () => {
		const ics = invite({ title: "No place", uid: "evt-2@example.com" });
		expect(parseEvents(ics)[0]?.location).toBeUndefined();
	});

	test("parses multiple VEVENTs in one calendar", () => {
		const combined = `${sample}\r\n${invite({
			end: "20260613T093000Z",
			start: "20260613T090000Z",
			title: "Second",
			uid: "evt-3@example.com",
		})}`;
		const events = parseEvents(combined);
		expect(events.map((e) => e.uid)).toEqual([
			"evt-1@example.com",
			"evt-3@example.com",
		]);
	});

	test("skips a VEVENT without a UID", () => {
		expect(
			parseEvents("BEGIN:VEVENT\r\nSUMMARY:Orphan\r\nEND:VEVENT")
		).toHaveLength(0);
	});

	test("unescapes TEXT values and unfolds folded lines", () => {
		const ics = [
			"BEGIN:VEVENT",
			"UID:x@example.com",
			"SUMMARY:Lunch\\, then a very long title that the",
			" server folded",
			"END:VEVENT",
		].join("\r\n");
		const [ev] = parseEvents(ics);
		expect(ev?.title).toBe(
			"Lunch, then a very long title that theserver folded"
		);
	});

	test("surfaces the DTSTART TZID of a timed event", () => {
		const ics =
			"BEGIN:VEVENT\r\nUID:zoned@example.com\r\nDTSTART;TZID=Europe/Berlin:20260612T100000\r\nEND:VEVENT";
		expect(parseEvents(ics)[0]?.startTzid).toBe("Europe/Berlin");
	});

	test("maps a Windows TZID to its IANA zone and keeps the name as stored", () => {
		const ics = [
			"BEGIN:VEVENT",
			"UID:outlook@example.com",
			"DTSTART;TZID=W. Europe Standard Time:20260710T100000",
			"RRULE:FREQ=WEEKLY",
			"EXDATE;TZID=W. Europe Standard Time:20260717T100000",
			"END:VEVENT",
			"BEGIN:VEVENT",
			"UID:outlook@example.com",
			"RECURRENCE-ID;TZID=W. Europe Standard Time:20260724T100000",
			"DTSTART;TZID=W. Europe Standard Time:20260724T120000",
			"END:VEVENT",
		].join("\r\n");
		const [master, override] = parseEvents(ics);
		expect(master?.startTzid).toBe("Europe/Berlin");
		expect(master?.storedStartTzid).toBe("W. Europe Standard Time");
		expect(master?.excludedDates).toEqual(["2026-07-17T08:00:00.000Z"]);
		expect(override?.recurrenceId).toBe("2026-07-24T08:00:00.000Z");
	});

	test("leaves a TZID that is neither IANA nor Windows as stored", () => {
		const ics =
			"BEGIN:VEVENT\r\nUID:v@example.com\r\nDTSTART;TZID=Example Standard Time:20260612T100000\r\nEND:VEVENT";
		const [event] = parseEvents(ics);
		expect(event?.startTzid).toBe("Example Standard Time");
		expect(event?.storedStartTzid).toBeUndefined();
	});

	test("drops a TZID written beside an all-day DATE", () => {
		const ics =
			"BEGIN:VEVENT\r\nUID:allday@example.com\r\nDTSTART;TZID=Europe/Berlin;VALUE=DATE:20260612\r\nEND:VEVENT";
		const [event] = parseEvents(ics);
		expect(event?.allDay).toBe(true);
		expect(event?.startTzid).toBeUndefined();
	});

	test("keeps a date-only value as a calendar date", () => {
		const ics =
			"BEGIN:VEVENT\r\nUID:allday@example.com\r\nDTSTART:20260612\r\nEND:VEVENT";
		expect(parseEvents(ics)[0]?.start).toBe("2026-06-12");
	});

	test("does not let a nested VALARM SUMMARY clobber the event title", () => {
		const ics = [
			"BEGIN:VEVENT",
			"UID:a@example.com",
			"SUMMARY:Real meeting",
			"DTSTART:20260612T100000Z",
			"BEGIN:VALARM",
			"TRIGGER:-PT15M",
			"SUMMARY:Reminder",
			"END:VALARM",
			"END:VEVENT",
		].join("\r\n");
		const [ev] = parseEvents(ics);
		expect(ev?.title).toBe("Real meeting");
	});

	test("extracts the bare organizer email, mailto: stripped", () => {
		const [ev] = parseEvents(sample);
		expect(ev?.organizer).toBe("host@example.com");
	});

	test("reads the organizer past params carrying quoted colons", () => {
		// Foreign clients (delegation, display names) put colons inside quoted
		// params; the cal-address is the mailto: URI at the end of the line.
		const ics = [
			"BEGIN:VEVENT",
			"UID:c@example.com",
			'ORGANIZER;SENT-BY="mailto:assistant@example.net";CN="Team: Weekly":mailto:boss@example.net',
			"END:VEVENT",
		].join("\r\n");
		expect(parseEvents(ics)[0]?.organizer).toBe("boss@example.net");
	});

	test("omits an organizer it cannot reduce to a bare address", () => {
		// A non-mailto cal-address (e.g. a principal URL) is useless for rebuilding
		// an invite — better absent (callers fall back to discovery) than garbage.
		const ics = [
			"BEGIN:VEVENT",
			"UID:d@example.com",
			'ORGANIZER;SENT-BY="mailto:assistant@example.net":/principals/users/boss/',
			"END:VEVENT",
		].join("\r\n");
		expect(parseEvents(ics)[0]?.organizer).toBeUndefined();
	});

	test("omits organizer when the event has none", () => {
		const ics =
			"BEGIN:VEVENT\r\nUID:e@example.com\r\nSUMMARY:No invitees\r\nEND:VEVENT";
		expect(parseEvents(ics)[0]?.organizer).toBeUndefined();
	});

	test("decodes an escaped backslash without turning it into a newline", () => {
		// RFC 5545: `\\` is a literal backslash, so `\\n` is backslash + "n".
		const ics =
			"BEGIN:VEVENT\r\nUID:b@example.com\r\nSUMMARY:path C:\\\\new\r\nEND:VEVENT";
		expect(parseEvents(ics)[0]?.title).toBe("path C:\\new");
	});

	test("extracts every attendee as a bare email, in source order", () => {
		const ics = invite({
			attendees: ["ada@example.org", "lin@example.com", "tor@example.com"],
			title: "Team",
			uid: "evt-att@example.com",
		});
		expect(parseEvents(ics)[0]?.attendees.map((a) => a.email)).toEqual([
			"ada@example.org",
			"lin@example.com",
			"tor@example.com",
		]);
	});

	test("reads each attendee PARTSTAT when present", () => {
		const ics = [
			"BEGIN:VEVENT",
			"UID:evt-partstat@example.com",
			"ATTENDEE;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:yes@example.com",
			"ATTENDEE;PARTSTAT=DECLINED:mailto:no@example.com",
			"ATTENDEE;RSVP=TRUE:mailto:pending@example.com",
			"END:VEVENT",
		].join("\r\n");
		expect(parseEvents(ics)[0]?.attendees).toEqual([
			{ email: "yes@example.com", status: "ACCEPTED" },
			{ email: "no@example.com", status: "DECLINED" },
			{ email: "pending@example.com" },
		]);
	});

	test("reads each attendee ROLE when present", () => {
		const ics = [
			"BEGIN:VEVENT",
			"UID:evt-role@example.com",
			"ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=TENTATIVE:mailto:maybe@example.com",
			"ATTENDEE;PARTSTAT=ACCEPTED:mailto:plain@example.com",
			"END:VEVENT",
		].join("\r\n");
		expect(parseEvents(ics)[0]?.attendees).toEqual([
			{
				email: "maybe@example.com",
				role: "OPT-PARTICIPANT",
				status: "TENTATIVE",
			},
			{ email: "plain@example.com", status: "ACCEPTED" },
		]);
	});

	test("gives an attendee-less event an empty attendee list", () => {
		const ics =
			"BEGIN:VEVENT\r\nUID:solo@example.com\r\nSUMMARY:Solo\r\nEND:VEVENT";
		expect(parseEvents(ics)[0]?.attendees).toEqual([]);
	});

	test("reads an attendee address and PARTSTAT past params carrying quoted colons", () => {
		const ics = [
			"BEGIN:VEVENT",
			"UID:evt-q@example.com",
			'ATTENDEE;CN="Team: Weekly";PARTSTAT=ACCEPTED:mailto:person@example.com',
			"END:VEVENT",
		].join("\r\n");
		// The quoted colon in CN pushes the first-colon split into the CN value, so
		// PARTSTAT must be recovered from the reassembled line, not the truncated params.
		expect(parseEvents(ics)[0]?.attendees[0]).toEqual({
			email: "person@example.com",
			name: "Team: Weekly",
			status: "ACCEPTED",
		});
	});

	test("reads a quoted CN display name off an attendee", () => {
		const ics = [
			"BEGIN:VEVENT",
			"UID:evt-cn@example.com",
			'ATTENDEE;CN="Fairweather, Robin";PARTSTAT=NEEDS-ACTION:mailto:robin@northwind.example',
			"END:VEVENT",
		].join("\r\n");
		expect(parseEvents(ics)[0]?.attendees[0]).toEqual({
			email: "robin@northwind.example",
			name: "Fairweather, Robin",
			status: "NEEDS-ACTION",
		});
	});

	test("reads an unquoted CN display name and omits name when CN is absent", () => {
		const ics = [
			"BEGIN:VEVENT",
			"UID:evt-cn2@example.com",
			"ATTENDEE;CN=Robin:mailto:robin@northwind.example",
			"ATTENDEE:mailto:anon@example.com",
			"END:VEVENT",
		].join("\r\n");
		const [ev] = parseEvents(ics);
		expect(ev?.attendees).toEqual([
			{ email: "robin@northwind.example", name: "Robin" },
			{ email: "anon@example.com" },
		]);
	});

	test("drops an attendee it cannot reduce to a bare address", () => {
		const ics = [
			"BEGIN:VEVENT",
			"UID:evt-bad@example.com",
			"ATTENDEE:/principals/users/someone/",
			"ATTENDEE:mailto:good@example.com",
			"END:VEVENT",
		].join("\r\n");
		expect(parseEvents(ics)[0]?.attendees).toEqual([
			{ email: "good@example.com" },
		]);
	});

	test("counts attendees it could not parse (a non-mailto cal-address)", () => {
		const ics = [
			"BEGIN:VEVENT",
			"UID:evt-urn@example.com",
			"ATTENDEE;CN=Jane;EMAIL=jane@example.com:urn:uuid:1234",
			"ATTENDEE:mailto:good@example.com",
			"END:VEVENT",
		].join("\r\n");
		const [ev] = parseEvents(ics);
		expect(ev?.attendees).toEqual([{ email: "good@example.com" }]);
		expect(ev?.unparsedAttendeeCount).toBe(1);
	});

	test("omits unparsedAttendeeCount when every attendee parsed cleanly", () => {
		expect(parseEvents(sample)[0]?.unparsedAttendeeCount).toBeUndefined();
	});

	test("extracts the DESCRIPTION, unescaped", () => {
		const ics = invite({
			description: "Line one\\; line two",
			title: "With notes",
			uid: "evt-desc@example.com",
		});
		expect(parseEvents(ics)[0]?.description).toBe("Line one; line two");
	});

	test("omits description when absent", () => {
		const ics =
			"BEGIN:VEVENT\r\nUID:nodesc@example.com\r\nSUMMARY:No notes\r\nEND:VEVENT";
		expect(parseEvents(ics)[0]?.description).toBeUndefined();
	});

	test("reads a UTC RECURRENCE-ID as the overridden instant", () => {
		const ics = [
			"BEGIN:VEVENT",
			"UID:series@example.com",
			"SUMMARY:Moved occurrence",
			"RECURRENCE-ID:20260623T100000Z",
			"DTSTART:20260623T110000Z",
			"DTEND:20260623T120000Z",
			"END:VEVENT",
		].join("\r\n");
		expect(parseEvents(ics)[0]?.recurrenceId).toBe("2026-06-23T10:00:00.000Z");
	});

	test("resolves a zoned RECURRENCE-ID against its TZID", () => {
		// 10:00 Berlin on 2026-06-23 (CEST, UTC+2) is the 08:00Z instant.
		const ics = [
			"BEGIN:VEVENT",
			"UID:series@example.com",
			"SUMMARY:Moved occurrence",
			"RECURRENCE-ID;TZID=Europe/Berlin:20260623T100000",
			"DTSTART;TZID=Europe/Berlin:20260623T110000",
			"DTEND;TZID=Europe/Berlin:20260623T120000",
			"END:VEVENT",
		].join("\r\n");
		expect(parseEvents(ics)[0]?.recurrenceId).toBe("2026-06-23T08:00:00.000Z");
	});

	test("omits recurrenceId on a master and on a one-off event", () => {
		expect(parseEvents(sample)[0]?.recurrenceId).toBeUndefined();
	});

	test("drops an unparsable RECURRENCE-ID rather than surfacing garbage", () => {
		const ics = [
			"BEGIN:VEVENT",
			"UID:series@example.com",
			"SUMMARY:Broken override",
			"RECURRENCE-ID:not-a-date",
			"END:VEVENT",
		].join("\r\n");
		expect(parseEvents(ics)[0]?.recurrenceId).toBeUndefined();
	});
});

describe("parseEvents — all-day events", () => {
	const allDay = [
		"BEGIN:VCALENDAR",
		"BEGIN:VEVENT",
		"UID:vacation-1",
		"SUMMARY:Vacation",
		"DTSTART;VALUE=DATE:20261003",
		"DTEND;VALUE=DATE:20261011",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");

	test("flags a DATE-valued DTSTART as all-day with date-only start/end", () => {
		const [event] = parseEvents(allDay);
		expect(event?.allDay).toBe(true);
		expect(event?.start).toBe("2026-10-03");
		expect(event?.end).toBe("2026-10-11");
	});

	test("flags a bare 8-digit DTSTART without VALUE=DATE as all-day", () => {
		const [event] = parseEvents(
			allDay.replace("DTSTART;VALUE=DATE:", "DTSTART:")
		);
		expect(event?.allDay).toBe(true);
	});

	test("leaves a timed event unflagged", () => {
		expect(parseEvents(invite())[0]?.allDay).toBeUndefined();
	});
});

describe("parseEvents — excluded dates", () => {
	const withExdate = (line: string): string =>
		invite({ rrule: "FREQ=WEEKLY" }).replace(
			"END:VEVENT",
			`${line}\r\nEND:VEVENT`
		);

	test("resolves a TZID-qualified EXDATE to a UTC instant", () => {
		// 12:00 Berlin summer time is 10:00Z; left floating it would read as local time.
		const [event] = parseEvents(
			withExdate("EXDATE;TZID=Europe/Berlin:20260623T120000,20260630T120000")
		);
		expect(event?.excludedDates).toEqual([
			"2026-06-23T10:00:00.000Z",
			"2026-06-30T10:00:00.000Z",
		]);
	});

	test("keeps UTC and DATE exclusions as stored", () => {
		expect(
			parseEvents(withExdate("EXDATE:20260623T100000Z"))[0]?.excludedDates
		).toEqual(["2026-06-23T10:00:00Z"]);
		expect(
			parseEvents(withExdate("EXDATE;VALUE=DATE:20260623"))[0]?.excludedDates
		).toEqual(["2026-06-23"]);
	});
});

describe("parseEvents — alarms", () => {
	const withAlarms = invite().replace(
		"END:VEVENT",
		[
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"TRIGGER:-PT30M",
			"DESCRIPTION:Sync",
			"END:VALARM",
			"BEGIN:VALARM",
			"ACTION:EMAIL",
			"TRIGGER;VALUE=DATE-TIME:20260612T080000Z",
			"SUMMARY:Heads-up",
			"DESCRIPTION:Long description that folds",
			" across two lines",
			"ATTENDEE:mailto:host@example.com",
			"END:VALARM",
			"END:VEVENT",
		].join("\r\n")
	);

	test("collects each VALARM verbatim (unfolded) with its action and trigger", () => {
		const [event] = parseEvents(withAlarms);
		expect(event?.alarms).toEqual([
			{
				action: "DISPLAY",
				lines: [
					"BEGIN:VALARM",
					"ACTION:DISPLAY",
					"TRIGGER:-PT30M",
					"DESCRIPTION:Sync",
					"END:VALARM",
				],
				trigger: "-PT30M",
			},
			{
				action: "EMAIL",
				lines: [
					"BEGIN:VALARM",
					"ACTION:EMAIL",
					"TRIGGER;VALUE=DATE-TIME:20260612T080000Z",
					"SUMMARY:Heads-up",
					"DESCRIPTION:Long description that foldsacross two lines",
					"ATTENDEE:mailto:host@example.com",
					"END:VALARM",
				],
				trigger: "20260612T080000Z",
				triggerParams: ";VALUE=DATE-TIME",
			},
		]);
	});

	test("alarm properties never leak onto the event", () => {
		const [event] = parseEvents(withAlarms);
		expect(event?.title).toBe("Sync");
		expect(event?.description).toBeUndefined();
		// The alarm's ATTENDEE is its email recipient, not an event attendee.
		expect(event?.attendees.map((a) => a.email)).toEqual(["guest@example.com"]);
	});

	test("matches VEVENT delimiters case-insensitively", () => {
		const lower = invite()
			.replace("BEGIN:VEVENT", "begin:vevent")
			.replace("END:VEVENT", "end:vevent");
		expect(parseEvents(lower)[0]?.title).toBe("Sync");
	});

	test("matches BEGIN:VALARM case-insensitively", () => {
		const lower = invite().replace(
			"END:VEVENT",
			"begin:valarm\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nend:valarm\r\nEND:VEVENT"
		);
		expect(parseEvents(lower)[0]?.alarms?.[0]?.trigger).toBe("-PT5M");
	});

	test("an event without alarms has no alarms field", () => {
		expect(parseEvents(invite())[0]?.alarms).toBeUndefined();
	});
});

describe("parseEvents — showAs", () => {
	const withTransp = (line: string): string =>
		invite().replace("END:VEVENT", `${line}\r\nEND:VEVENT`);

	test("reads TRANSPARENT as free and OPAQUE as busy", () => {
		expect(parseEvents(withTransp("TRANSP:TRANSPARENT"))[0]?.showAs).toBe(
			"free"
		);
		expect(parseEvents(withTransp("TRANSP:OPAQUE"))[0]?.showAs).toBe("busy");
	});

	test("reads the value case-insensitively", () => {
		expect(parseEvents(withTransp("TRANSP:Transparent"))[0]?.showAs).toBe(
			"free"
		);
		expect(parseEvents(withTransp("transp:opaque"))[0]?.showAs).toBe("busy");
	});

	test("leaves showAs unset without TRANSP or with an unrecognised value", () => {
		expect(parseEvents(invite())[0]?.showAs).toBeUndefined();
		expect(
			parseEvents(withTransp("TRANSP:X-SOMETIMES"))[0]?.showAs
		).toBeUndefined();
	});

	test("reads each VEVENT of a recurring series on its own", () => {
		const series = invite({ rrule: "FREQ=WEEKLY" }).replace(
			"END:VCALENDAR",
			[
				"BEGIN:VEVENT",
				"UID:evt-1@example.com",
				"RECURRENCE-ID:20260619T100000Z",
				"END:VEVENT",
				"END:VCALENDAR",
			].join("\r\n")
		);
		const [master, override] = parseEvents(
			series.replace("RRULE:", "TRANSP:TRANSPARENT\r\nRRULE:")
		);
		expect(master?.showAs).toBe("free");
		expect(override?.showAs).toBeUndefined();
	});
});

describe("parseEvents — status and classification", () => {
	const withLine = (line: string): string =>
		invite().replace("END:VEVENT", `${line}\r\nEND:VEVENT`);

	test("reads STATUS and CLASS uppercased", () => {
		expect(parseEvents(withLine("STATUS:cancelled"))[0]?.status).toBe(
			"CANCELLED"
		);
		expect(parseEvents(withLine("CLASS:Private"))[0]?.classification).toBe(
			"PRIVATE"
		);
	});

	test("reads DURATION as stored", () => {
		expect(parseEvents(withLine("DURATION:PT2H"))[0]?.duration).toBe("PT2H");
	});

	test("leaves both unset when the VEVENT carries neither", () => {
		const [event] = parseEvents(invite());
		expect(event?.status).toBeUndefined();
		expect(event?.classification).toBeUndefined();
	});

	test("ignores a VALARM STATUS", () => {
		const alarm = invite().replace(
			"END:VEVENT",
			"BEGIN:VALARM\r\nACTION:DISPLAY\r\nSTATUS:CANCELLED\r\nTRIGGER:-PT5M\r\nEND:VALARM\r\nEND:VEVENT"
		);
		expect(parseEvents(alarm)[0]?.status).toBeUndefined();
	});
});
