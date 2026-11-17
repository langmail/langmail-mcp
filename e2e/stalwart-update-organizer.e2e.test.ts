// E2E for the organizer-preservation fix in update_calendar_event against a
// REAL Stalwart — the one behaviour only Stalwart can verify: its PUT
// validation rejects an object whose components carry different ORGANIZERs
// with 412 `SameOrganizerInAllComponents`. That is exactly what the tool used
// to produce when editing an event created under a previous account address
// (still an enabled alias): it stamped the freshly discovered principal onto
// the rebuilt component while the stored master kept the old alias.
//
// The test provisions a throwaway account with an alias, seeds a recurring event whose ORGANIZER is the address discovery does NOT return,
// then drives the real tool (live deps, CalDAV all the way) through both edit
// modes and asserts the stored organizer survives.
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
import { provisionPrincipal } from "./support/caldav.ts";
import { DOMAIN, live } from "./support/env.ts";

// 10:00Z on a Tuesday comfortably in the future, so Stalwart treats the
// series as schedulable and the run date never catches up with it.
const nextTuesday = (): Date => {
	const d = new Date();
	// Days until the next Tuesday (day 2), plus four full weeks of headroom
	// (a multiple of 7, so the weekday is preserved).
	d.setUTCDate(d.getUTCDate() + 28 + ((9 - d.getUTCDay()) % 7 || 7));
	d.setUTCHours(10, 0, 0, 0);
	return d;
};

const hoursLater = (from: Date, hours: number): Date =>
	new Date(from.getTime() + hours * 3_600_000);

live(
	"update_calendar_event against live Stalwart — stored ORGANIZER survives edits",
	() => {
		const run = Date.now();
		const localPart = `mcp-e2e-${run}`;
		const aliasPart = `${localPart}-old`;
		let cfg: CalDavConfig;
		// The account's credential: what the tool and the client take as `token`.
		let token: string;
		let calendarUrl: string;
		// The account address the tool would wrongly stamp (discovery result) and
		// the one the seeded events actually carry.
		let discovered: string;
		let storedOrganizer: string;

		beforeAll(async () => {
			// Account + retained-previous-address alias: the shape an address
			// change leaves behind.
			const principal = await provisionPrincipal("organizer", {
				aliases: [aliasPart],
				localPart,
			});
			({ cfg, token } = principal);
			calendarUrl = principal.defaultUrl;
			discovered = principal.organizer;
			// Seed with whichever of the two account addresses discovery does NOT
			// return, so the stored ORGANIZER genuinely differs from what the tool
			// would stamp — what an account looks like after an address change.
			const primary = `${localPart}@${DOMAIN}`;
			const alias = `${aliasPart}@${DOMAIN}`;
			storedOrganizer = discovered === alias ? primary : alias;
			expect(storedOrganizer).not.toBe(discovered);
		});

		// Throwaway principal; destroying it also drops its calendar data.
		afterAll(destroyCreatedAccounts);

		test("occurrence edit PUTs an override that Stalwart accepts and keeps the stored ORGANIZER", async () => {
			const uid = `organizer-occurrence-${run}@mcp-e2e`;
			const start = nextTuesday();
			await putEvent(cfg, {
				calendarUrl,
				ical: buildInvite({
					attendees: ["guest@example.com"],
					end: hoursLater(start, 0.5),
					organizer: storedOrganizer,
					rrule: "FREQ=WEEKLY;BYDAY=TU",
					start,
					title: "Weekly sync",
					uid,
				}),
				token,
			});

			const occurrence = new Date(start.getTime() + 7 * 86_400_000);
			const result = await updateCalendarEvent(makeLiveDeps(cfg), {
				args: {
					attendees: ["guest@example.com"],
					end: hoursLater(occurrence, 2.5).toISOString(),
					recurrenceId: occurrence.toISOString(),
					start: hoursLater(occurrence, 2).toISOString(),
					title: "Weekly sync (moved)",
					uid,
				},
				token,
			});

			// Pre-fix this PUT died with `caldav PUT returned 412`
			// (SameOrganizerInAllComponents) before any result came back.
			expect(result.isError).toBeUndefined();

			const stored = await fetchEvent(cfg, { calendarUrl, token, uid });
			expect(stored).not.toBeNull();
			const events = parseEvents(stored?.data ?? "");
			expect(events).toHaveLength(2);
			expect(events.map((e) => e.organizer)).toEqual([
				storedOrganizer,
				storedOrganizer,
			]);
		});

		test("full edit keeps the stored ORGANIZER instead of re-stamping the discovered principal", async () => {
			const uid = `organizer-full-${run}@mcp-e2e`;
			const start = nextTuesday();
			await putEvent(cfg, {
				calendarUrl,
				ical: buildInvite({
					attendees: ["guest@example.com"],
					end: hoursLater(start, 1),
					organizer: storedOrganizer,
					start,
					title: "One-off",
					uid,
				}),
				token,
			});

			const result = await updateCalendarEvent(makeLiveDeps(cfg), {
				args: {
					attendees: ["guest@example.com"],
					end: hoursLater(start, 3).toISOString(),
					start: hoursLater(start, 2).toISOString(),
					title: "One-off (moved)",
					uid,
				},
				token,
			});
			expect(result.isError).toBeUndefined();

			const stored = await fetchEvent(cfg, { calendarUrl, token, uid });
			expect(stored).not.toBeNull();
			const events = parseEvents(stored?.data ?? "");
			expect(events).toHaveLength(1);
			expect(events[0]?.organizer).toBe(storedOrganizer);
			expect(events[0]?.organizer).not.toBe(discovered);
		});
	}
);
