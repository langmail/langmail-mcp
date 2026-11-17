// E2E for moving a single occurrence (update_calendar_event + recurrenceId)
// against a REAL Stalwart, asserting the iMIP *method* the attendee receives —
// the part a server without scheduling can't reproduce.
//
// This is the regression gate for a defect Stalwart carried from 0.16.13 to
// 0.16.20: `organizer_handle_update` classified a freshly spliced
// RECURRENCE-ID override as an instance "present only in the new object" and
// announced it as iTIP `METHOD:ADD`. RFC 5546 §3.2.4 forbids RECURRENCE-ID in
// METHOD:ADD and §4.4.2 requires METHOD:REQUEST for changing an existing
// instance, so Google Calendar rendered the attendee's copy as "Unable to load
// event" while the organiser saw nothing wrong. Fixed in 0.16.21 (the branch
// now yields `Request`); this test is what keeps a later release from
// regressing it, so its assertions are deliberately about the delivered
// method, not about the PUT being accepted (that is
// stalwart-update-organizer.e2e.test.ts).
//
// It provisions two throwaway accounts: an organizer and a LOCAL
// attendee, because only a local attendee's mailbox can be read back. The
// organizer seeds a weekly series inviting the attendee, then the real update
// tool (live deps, CalDAV all the way) moves occurrence #2.
//
// Skips unless STALWART_ADMIN_URL is set; see e2e/README.md.

import { afterAll, beforeAll, expect, test } from "vitest";
import {
	type CalDavConfig,
	fetchEvent,
	putEvent,
} from "../src/caldav/client.ts";
import { buildInvite } from "../src/caldav/ical.ts";
import { parseEvents } from "../src/ical/index.ts";
import {
	makeLiveDeps,
	updateCalendarEvent,
} from "../src/tools/update-calendar-event.ts";
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

live(
	"update_calendar_event single-occurrence move against live Stalwart",
	() => {
		const run = Date.now();
		let attendee: Principal;
		let attendeeAddr: string;
		let cfg: CalDavConfig;
		// The organizer's credential: what the tool and the client take as `token`.
		let token: string;
		let calendarUrl: string;
		let organizer: string;

		beforeAll(async () => {
			const org = await provisionPrincipal("move-org", {
				localPart: `move-org-${run}`,
			});
			attendee = await provisionPrincipal("move-att", {
				localPart: `move-att-${run}`,
			});
			attendeeAddr = attendee.addr;
			({ cfg, organizer, token } = org);
			calendarUrl = org.defaultUrl;
		});

		// Throwaway principals; destroying them also drops their calendar/mail data.
		afterAll(destroyCreatedAccounts);

		test("moves one occurrence: the attendee gets METHOD:REQUEST with a RECURRENCE-ID, never METHOD:ADD", async () => {
			const uid = `move-occurrence-${run}@mcp-e2e`;
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
			// Wait for the initial series invitation, so the move fan-out is a genuine
			// second delivery rather than a race with the first.
			expect(
				await calendarMessageWith(attendee, "RRULE:FREQ=WEEKLY;BYDAY=TU")
			).not.toBeNull();

			// Move occurrence #2 (one week out — still a Tuesday, so on the rule) two
			// hours later. The moved title is what distinguishes the override's
			// scheduling message from the initial invite still sitting in the mailbox.
			const occurrence = new Date(start.getTime() + 7 * 86_400_000);
			const movedTitle = "Weekly sync (moved)";
			const result = await updateCalendarEvent(makeLiveDeps(cfg), {
				args: {
					attendees: [attendeeAddr],
					end: hoursLater(occurrence, 2.5).toISOString(),
					recurrenceId: occurrence.toISOString(),
					start: hoursLater(occurrence, 2).toISOString(),
					title: movedTitle,
					uid,
				},
				token,
			});
			expect(result.isError).toBeUndefined();

			// Stored object: master plus the spliced override, both still present.
			const stored = await fetchEvent(cfg, { calendarUrl, token, uid });
			expect(stored).not.toBeNull();
			expect(parseEvents(stored?.data ?? "")).toHaveLength(2);

			// The regression gate. Pre-0.16.21 this message was a METHOD:ADD carrying a
			// RECURRENCE-ID — invalid per RFC 5546 §3.2.4 and unrenderable in Google
			// Calendar. It must be a METHOD:REQUEST scoped to the instance.
			const delivered = await calendarMessageWith(attendee, movedTitle);
			expect(delivered).not.toBeNull();
			expect(delivered).toContain("RECURRENCE-ID");
			expect(delivered).toContain("METHOD:REQUEST");
			expect(delivered).not.toContain("METHOD:ADD");
		}, 120_000);
	}
);
