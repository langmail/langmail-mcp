// E2E for attendee-delta edits (update_calendar_event + addedAttendees/
// removedAttendees + notify) against a REAL Stalwart — the fan-out behaviour
// a server without scheduling can't reproduce. This is the acceptance
// proof for the reported gap: a single attendee is removed from a recurring
// meeting through the connector alone, re-passing neither the recurrence rule
// nor the other attendees, and — with notify:'none' — without disturbing the
// attendees who remain.
//
// It provisions three throwaway accounts: an organizer and two LOCAL
// attendees (one that gets removed, one that stays). The organizer seeds a
// weekly series inviting both, then the real update tool (live deps, CalDAV all
// the way) removes one attendee by email. We assert:
//   1. quiet path (notify:'none') — the stored series drops the removed attendee,
//      keeps the other AND its RRULE, and the remaining attendee is NOT
//      re-notified (a subsequent loud edit proves the mailbox pipe is live, so
//      the zero-delivery is real suppression, not a dead channel);
//   2. loud path (notify default 'all') — removing an attendee DOES re-notify the
//      remaining attendee, and the delivered series no longer lists the removed one.
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
	messageCount,
	type Principal,
	provisionPrincipal,
	staysAt,
	unfold,
	waitForNewMessages,
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

live("update_calendar_event attendee deltas against live Stalwart", () => {
	const run = Date.now();
	let cfg: CalDavConfig;
	// The organizer's credential: what the tool and the client take as `token`.
	let token: string;
	let calendarUrl: string;
	let organizer: string;
	// [removed, remaining] pairs — one pair per test so mailbox counts don't cross.
	const removed: Principal[] = [];
	const remaining: Principal[] = [];

	beforeAll(async () => {
		const org = await provisionPrincipal("ad-org", {
			localPart: `ad-org-${run}`,
		});
		({ cfg, organizer, token } = org);
		calendarUrl = org.defaultUrl;

		for (let i = 1; i <= 2; i += 1) {
			removed.push(
				await provisionPrincipal("ad-gone", {
					localPart: `ad-gone${i}-${run}`,
				})
			);
			remaining.push(
				await provisionPrincipal("ad-stay", {
					localPart: `ad-stay${i}-${run}`,
				})
			);
		}
	});

	afterAll(destroyCreatedAccounts);

	// Seeds a weekly series inviting [removed, remaining] and waits until the
	// remaining attendee has received the initial invitation.
	const seedSeries = async (uid: string, gone: Principal, stay: Principal) => {
		const start = nextTuesday();
		await putEvent(cfg, {
			calendarUrl,
			ical: buildInvite({
				attendees: [gone.addr, stay.addr],
				end: hoursLater(start, 0.5),
				organizer,
				rrule: "FREQ=WEEKLY;BYDAY=TU",
				start,
				title: "unvibe meeting",
				uid,
			}),
			token,
		});
		const invited = await waitForNewMessages(stay, 0);
		expect(invited).not.toBeNull();
	};

	test("notify:none removes one attendee without re-passing the rule or the others, and stays quiet", async () => {
		const gone = removed[0] as Principal;
		const stay = remaining[0] as Principal;
		const uid = `attendee-delta-quiet-${run}@mcp-e2e`;
		await seedSeries(uid, gone, stay);
		const stayBaseline = await messageCount(stay);

		// The whole acceptance surface in one call: name only the address to drop,
		// and ask for silence. No recurrence, no other attendees, no times.
		const result = await updateCalendarEvent(makeLiveDeps(cfg), {
			args: { notify: "none", removedAttendees: [gone.addr], uid },
			token,
		});
		expect(result.isError).toBeUndefined();

		// Stored series: the removed attendee is gone, the remaining one survives,
		// the RRULE is intact, and it's still a single (master) VEVENT.
		const stored = await fetchEvent(cfg, { calendarUrl, token, uid });
		expect(stored).not.toBeNull();
		const events = parseEvents(stored?.data ?? "");
		expect(events).toHaveLength(1);
		const emails = (events[0]?.attendees ?? []).map((a) =>
			a.email.toLowerCase()
		);
		expect(emails).toContain(stay.addr.toLowerCase());
		expect(emails).not.toContain(gone.addr.toLowerCase());
		expect(events[0]?.recurrence).toBe("FREQ=WEEKLY;BYDAY=TU");

		// The remaining attendee is NOT re-notified by the quiet edit.
		expect(await staysAt(stay, stayBaseline)).toBe(true);

		// Prove the mailbox pipe is live: a subsequent loud edit (default notify)
		// DOES reach them, so the silence above was real suppression, not a dead
		// channel. Re-adding the dropped attendee is a real, notifying change.
		const loud = await updateCalendarEvent(makeLiveDeps(cfg), {
			args: { addedAttendees: [gone.addr], uid },
			token,
		});
		expect(loud.isError).toBeUndefined();
		expect(await waitForNewMessages(stay, stayBaseline)).not.toBeNull();
	}, 240_000);

	test("default notify re-notifies the remaining attendee and drops the removed one from their copy", async () => {
		const gone = removed[1] as Principal;
		const stay = remaining[1] as Principal;
		const uid = `attendee-delta-loud-${run}@mcp-e2e`;
		await seedSeries(uid, gone, stay);
		const stayBaseline = await messageCount(stay);

		// Same delta, but notify defaults to 'all'.
		const result = await updateCalendarEvent(makeLiveDeps(cfg), {
			args: { removedAttendees: [gone.addr], uid },
			token,
		});
		expect(result.isError).toBeUndefined();

		const delivered = await waitForNewMessages(stay, stayBaseline);
		expect(delivered).not.toBeNull();
		// At least one delivered scheduling message for this event is the updated
		// series (RRULE intact) that no longer lists the removed attendee — the
		// initial invite still lists them, so match on the update specifically.
		// Unfold first: the folded ATTENDEE address would otherwise never substring-
		// match, making `!includes(gone.addr)` vacuously true (a false green).
		const updates = (delivered ?? [])
			.map(unfold)
			.filter((b) => b.includes("BEGIN:VCALENDAR") && b.includes(uid));
		expect(
			updates.some(
				(b) =>
					b.includes("RRULE:FREQ=WEEKLY;BYDAY=TU") && !b.includes(gone.addr)
			)
		).toBe(true);
	}, 240_000);
});
