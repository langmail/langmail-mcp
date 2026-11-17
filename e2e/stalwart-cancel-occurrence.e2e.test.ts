// E2E for single-occurrence cancellation (delete_calendar_event + recurrenceId)
// against a REAL Stalwart, verifying the full fan-out — the part a server without
// scheduling can't reproduce.
//
// It provisions two throwaway accounts: an organizer and a LOCAL
// attendee. The organizer seeds a weekly series inviting the attendee, then the
// real delete tool (live deps, CalDAV all the way) cancels one occurrence. We
// assert both sides:
//   1. the stored object survives the PUT with the instant excluded (EXDATE on
//      the master, no override, RRULE intact) — i.e. Stalwart's scheduler ACCEPTS
//      the EXDATE + bumped-SEQUENCE object rather than rejecting it;
//   2. the attendee actually receives the scheduling message. NB (this is the
//      verification spike for the design's SEQUENCE question): Stalwart 1.0
//      delivers a single-occurrence cancellation as a *per-instance
//      METHOD:CANCEL* whose RECURRENCE-ID names the excluded instant (RFC 5546
//      §3.2.5); the attendee client drops just that occurrence and keeps the
//      series. 0.16 sent an updated-series METHOD:REQUEST carrying the EXDATE
//      instead. The bumped master SEQUENCE is what makes the client treat the
//      message as newer than the invitation (RFC 5546) — hence we keep it.
//
// Skips unless STALWART_ADMIN_URL is set; see e2e/README.md.

import { afterAll, beforeAll, expect, test } from "vitest";
import {
	type CalDavConfig,
	fetchEvent,
	putEvent,
} from "../src/caldav/client.ts";
import { buildInvite } from "../src/caldav/ical.ts";
import { toIcalUtc } from "../src/caldav/recurrence.ts";
import { parseEvents } from "../src/ical/index.ts";
import {
	deleteCalendarEvent,
	makeLiveDeps,
} from "../src/tools/delete-calendar-event.ts";
import { destroyCreatedAccounts } from "./support/admin.ts";
import {
	calendarMessageWith,
	type Principal,
	provisionPrincipal,
} from "./support/caldav.ts";
import { live } from "./support/env.ts";

// 10:00Z on a Tuesday comfortably in the future, so Stalwart treats the series
// as schedulable and the run date never catches up with it.
const nextTuesday = (): Date => {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + 28 + ((9 - d.getUTCDay()) % 7 || 7));
	d.setUTCHours(10, 0, 0, 0);
	return d;
};
const hoursLater = (from: Date, hours: number): Date =>
	new Date(from.getTime() + hours * 3_600_000);

live("delete_calendar_event single occurrence against live Stalwart", () => {
	const run = Date.now();
	let attendee: Principal;
	let attendeeAddr: string;
	let cfg: CalDavConfig;
	// The organizer's credential: what the tool and the client take as `token`.
	let token: string;
	let calendarUrl: string;
	let organizer: string;

	beforeAll(async () => {
		const org = await provisionPrincipal("cancel-org", {
			localPart: `cancel-org-${run}`,
		});
		attendee = await provisionPrincipal("cancel-att", {
			localPart: `cancel-att-${run}`,
		});
		attendeeAddr = attendee.addr;
		({ cfg, organizer, token } = org);
		calendarUrl = org.defaultUrl;
	});

	// Throwaway principals; destroying them also drops their calendar/mail data.
	afterAll(destroyCreatedAccounts);

	test("cancels one occurrence: Stalwart accepts the EXDATE PUT and the attendee gets the exclusion", async () => {
		const uid = `cancel-occurrence-${run}@mcp-e2e`;
		const start = nextTuesday();
		await putEvent(cfg, {
			calendarUrl,
			ical: buildInvite({
				attendees: [attendeeAddr],
				end: hoursLater(start, 0.5),
				organizer,
				rrule: "FREQ=WEEKLY;BYDAY=TU",
				start,
				title: "Weekly sync",
				uid,
			}),
			token,
		});
		// Wait for the initial series invitation to reach the attendee, so the cancel
		// fan-out is a genuine second delivery, not a race with the first.
		const invite = await calendarMessageWith(
			attendee,
			"RRULE:FREQ=WEEKLY;BYDAY=TU"
		);
		expect(invite).not.toBeNull();

		// Cancel occurrence #2 (one week out — still a Tuesday, so on the rule).
		const occurrence = new Date(start.getTime() + 7 * 86_400_000);
		const exdate = toIcalUtc(occurrence.toISOString());
		const result = await deleteCalendarEvent(makeLiveDeps(cfg), {
			args: { calendarUrl, recurrenceId: occurrence.toISOString(), uid },
			token,
		});

		// On rejection this would surface `caldav PUT returned <4xx>`; the scheduler
		// accepting the EXDATE + master SEQUENCE bump is half the point.
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("cancelled");

		// Stored object: the instant is excluded on the master, the master still
		// recurs, and no override dangles.
		const stored = await fetchEvent(cfg, { calendarUrl, token, uid });
		expect(stored).not.toBeNull();
		expect(stored?.data).toContain(`EXDATE:${exdate}`);
		expect(stored?.data).not.toContain("RECURRENCE-ID");
		const events = parseEvents(stored?.data ?? "");
		expect(events).toHaveLength(1);
		expect(events[0]?.recurrence).toBeDefined();

		// Fan-out: the attendee receives a CANCEL for that one instance — it names
		// the instant in RECURRENCE-ID and carries no RRULE, so it is NOT a
		// whole-series cancellation.
		const delivered = await calendarMessageWith(
			attendee,
			`RECURRENCE-ID:${exdate}`
		);
		expect(delivered).not.toBeNull();
		expect(delivered).toContain("METHOD:CANCEL");
		expect(delivered).toContain("STATUS:CANCELLED");
		expect(delivered).not.toContain("RRULE:");
	}, 60_000);
});
