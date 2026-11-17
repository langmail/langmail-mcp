// E2E against a REAL Stalwart: update_calendar_event keeps the
// properties it does not model. Before the fix the whole-event rebuild wrote
// only what buildInvite knows, so CATEGORIES, CLASS, URL, TRANSP and X-
// properties vanished on every edit. The tool now carries them over from the
// stored VEVENT (caldav/occurrence.ts carryStoredProperties).
//
// It provisions one throwaway account, seeds an event with an external attendee carrying VALARM, CATEGORIES,
// CLASS, URL, TRANSP and an X- property, edits its title and then its time
// through the real tool (live deps), and reads it back after each edit.
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
import { live } from "./support/env.ts";

// 10:00Z four weeks out, so Stalwart treats the event as schedulable.
const inFourWeeks = (): Date => {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + 28);
	d.setUTCHours(10, 0, 0, 0);
	return d;
};

const hoursLater = (from: Date, hours: number): Date =>
	new Date(from.getTime() + hours * 3_600_000);

const KEPT = [
	"CATEGORIES:Work,Planning",
	"CLASS:PRIVATE",
	"URL:https://example.com/agenda",
	"TRANSP:TRANSPARENT",
	"X-ACME-NOTE:kept across edits",
];
const ALARM = [
	"BEGIN:VALARM",
	"ACTION:DISPLAY",
	"TRIGGER:-PT15M",
	"DESCRIPTION:Planning",
	"END:VALARM",
];

const LINE_BREAK_RE = /\r?\n/u;
const unfold = (ical: string): string => ical.replace(/\r\n[ \t]/gu, "");

// The stored VEVENT keeps every seeded property, value for value. Stalwart may
// re-serialize, so each is looked up by its whole unfolded line.
const expectKept = (ical: string): void => {
	const lines = unfold(ical).split(LINE_BREAK_RE);
	for (const line of KEPT) {
		expect(lines).toContain(line);
	}
	expect(lines).toContain("BEGIN:VALARM");
	expect(lines).toContain("TRIGGER:-PT15M");
};

live(
	"update_calendar_event against live Stalwart — unmodelled properties survive edits",
	() => {
		const run = Date.now();
		let cfg: CalDavConfig;
		// The account's credential: what the tool and the client take as `token`.
		let token: string;
		let calendarUrl: string;
		let organizer: string;

		beforeAll(async () => {
			const principal = await provisionPrincipal("props");
			({ cfg, organizer, token } = principal);
			calendarUrl = principal.defaultUrl;
		});

		afterAll(destroyCreatedAccounts);

		test("a title edit and then a time move keep VALARM, CATEGORIES, CLASS, URL, TRANSP and an X- property", async () => {
			const uid = `keeps-properties-${run}`;
			const start = inFourWeeks();
			const seeded = buildInvite({
				attendees: ["guest@example.com"],
				end: hoursLater(start, 1),
				organizer,
				start,
				title: "Planning",
				uid,
			}).replace("END:VEVENT", () =>
				[...KEPT, ...ALARM, "END:VEVENT"].join("\r\n")
			);
			await putEvent(cfg, { calendarUrl, ical: seeded, token });
			const before = await fetchEvent(cfg, { calendarUrl, token, uid });
			expectKept(before?.data ?? "");

			const retitled = await updateCalendarEvent(makeLiveDeps(cfg), {
				args: { notify: "none", title: "Planning (renamed)", uid },
				token,
			});
			expect(retitled.isError).toBeUndefined();
			const afterTitle = await fetchEvent(cfg, {
				calendarUrl,
				token,
				uid,
			});
			expect(parseEvents(afterTitle?.data ?? "")[0]?.title).toBe(
				"Planning (renamed)"
			);
			expectKept(afterTitle?.data ?? "");

			const moved = await updateCalendarEvent(makeLiveDeps(cfg), {
				args: {
					notify: "none",
					start: hoursLater(start, 2).toISOString(),
					uid,
				},
				token,
			});
			expect(moved.isError).toBeUndefined();
			const afterMove = await fetchEvent(cfg, {
				calendarUrl,
				token,
				uid,
			});
			const events = parseEvents(afterMove?.data ?? "");
			expect(events).toHaveLength(1);
			expect(Date.parse(events[0]?.start ?? "")).toBe(
				hoursLater(start, 2).getTime()
			);
			expectKept(afterMove?.data ?? "");
		});
	}
);
