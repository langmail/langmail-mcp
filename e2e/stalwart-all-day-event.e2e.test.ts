// Live-Stalwart e2e for all-day events and reminders through the MCP tools.
// The unit tests prove what we serialize; this proves Stalwart stores it and
// hands it back so the round trip an agent relies on holds:
//   create (date-only start/end + reminder) → list → partial update → list.
// Along the way it pins that a rename keeps both the DATE values and the
// VALARM, that a date-only move keeps the length in days, that an event
// switches between all-day and timed, and that Stalwart accepts a DATE
// RECURRENCE-ID override of an all-day series with a DATE UNTIL.
//
// Skips unless STALWART_ADMIN_URL is set; see e2e/README.md.

import { afterAll, beforeAll, expect, test } from "vitest";
import {
	type CalDavConfig,
	fetchEvent,
	updateEvent,
} from "../src/caldav/client.ts";
import { parseEvents } from "../src/ical/index.ts";
import {
	type CreateCalendarEventArgs,
	createCalendarEvent,
	makeLiveDeps as makeCreateDeps,
} from "../src/tools/create-calendar-event.ts";
import {
	deleteCalendarEvent,
	makeLiveDeps as makeDeleteDeps,
} from "../src/tools/delete-calendar-event.ts";
import {
	listCalendarEvents,
	makeLiveDeps as makeListDeps,
} from "../src/tools/list-calendar-events.ts";
import {
	makeLiveDeps as makeUpdateDeps,
	type UpdateCalendarEventArgs,
	updateCalendarEvent,
} from "../src/tools/update-calendar-event.ts";
import { destroyCreatedAccounts } from "./support/admin.ts";
import { provisionPrincipal } from "./support/caldav.ts";
import { live } from "./support/env.ts";

const UID_LINE_RE = /^uid: (.+)$/mu;
const SEQUENCE_RE = /^SEQUENCE:\d+/mu;

live("all-day events and reminders against live Stalwart", () => {
	let cfg: CalDavConfig;
	// The account's credential: what the tools and the client take as `token`.
	let token: string;
	let calendarUrl: string;

	// A fixed account zone, so the test doesn't depend on AccountSettings.
	const resolveTimeZone = () => Promise.resolve("Europe/Berlin");

	const create = async (args: CreateCalendarEventArgs): Promise<string> => {
		const result = await createCalendarEvent(
			makeCreateDeps(cfg, resolveTimeZone),
			{ args, token }
		);
		expect(result.isError).toBeUndefined();
		const uid = UID_LINE_RE.exec(result.content[0]?.text ?? "")?.[1];
		if (!uid) {
			throw new Error(`create returned no uid: ${result.content[0]?.text}`);
		}
		return uid;
	};

	const update = async (args: UpdateCalendarEventArgs): Promise<void> => {
		const result = await updateCalendarEvent(
			makeUpdateDeps(cfg, resolveTimeZone),
			{ args, token }
		);
		expect(result.isError).toBeUndefined();
	};

	// The list_calendar_events block for one event.
	const listed = async (uid: string): Promise<string> => {
		const result = await listCalendarEvents(makeListDeps(cfg), {
			args: {},
			token,
		});
		const block = (result.content[0]?.text ?? "")
			.split("\n\n")
			.find((b) => b.includes(`uid: ${uid}`));
		if (!block) {
			throw new Error(`event ${uid} not listed: ${result.content[0]?.text}`);
		}
		return block;
	};

	const stored = async (uid: string) => {
		const object = await fetchEvent(cfg, { calendarUrl, token, uid });
		if (!object) {
			throw new Error(`event ${uid} not stored`);
		}
		return {
			events: parseEvents(object.data),
			raw: object.data.replace(/\r\n[ \t]/gu, ""),
		};
	};

	beforeAll(async () => {
		const principal = await provisionPrincipal("all-day");
		({ cfg, token } = principal);
		calendarUrl = principal.defaultUrl;
	});

	// Throwaway principal; destroying it also drops its calendar data.
	afterAll(destroyCreatedAccounts);

	test("create → list → partial update → list keeps an all-day event all-day, reminder included", async () => {
		const uid = await create({
			end: "2026-10-11",
			reminderMinutesBefore: 900,
			start: "2026-10-03",
			title: "Vacation",
		});

		const first = await stored(uid);
		expect(first.raw).toContain("DTSTART;VALUE=DATE:20261003");
		expect(first.raw).toContain("DTEND;VALUE=DATE:20261011");
		expect(first.raw).toContain("TRIGGER:-PT15H");
		expect(await listed(uid)).toContain(
			"when: 2026-10-03 → 2026-10-11 (all day; end date exclusive)"
		);
		expect(await listed(uid)).toContain("reminder: 09:00 the day before");

		// A rename touches neither the dates nor the reminder.
		await update({ title: "Vacation (Lisbon)", uid });
		const renamed = await listed(uid);
		expect(renamed).toContain("Vacation (Lisbon)");
		expect(renamed).toContain(
			"when: 2026-10-03 → 2026-10-11 (all day; end date exclusive)"
		);
		expect(renamed).toContain("reminder: 09:00 the day before");

		// A date-only move keeps the eight days.
		await update({ start: "2026-10-17", uid });
		expect(await listed(uid)).toContain(
			"when: 2026-10-17 → 2026-10-25 (all day; end date exclusive)"
		);
	});

	test("switches an event from all-day to timed and back", async () => {
		const uid = await create({
			end: "2026-11-07",
			start: "2026-11-06",
			title: "Friday off",
		});

		await update({
			end: "2026-11-06T12:00:00",
			start: "2026-11-06T09:00:00",
			uid,
		});
		const timed = await stored(uid);
		expect(timed.events[0]?.allDay).toBeUndefined();
		expect(timed.raw).toContain("DTSTART;TZID=Europe/Berlin:20261106T090000");
		expect(await listed(uid)).toContain(
			"when: 2026-11-06T09:00:00 → 2026-11-06T12:00:00 (Europe/Berlin)"
		);

		await update({ end: "2026-11-07", start: "2026-11-06", uid });
		expect((await stored(uid)).events[0]?.allDay).toBe(true);
		expect(await listed(uid)).toContain(
			"when: 2026-11-06 → 2026-11-07 (all day; end date exclusive)"
		);
	});

	test("edits one occurrence of a bounded all-day series", async () => {
		const uid = await create({
			end: "2026-10-07",
			recurrence: { byDay: ["TU"], frequency: "weekly", until: "2026-12-29" },
			reminderMinutesBefore: 60,
			start: "2026-10-06",
			title: "Gym",
		});
		// Stalwart reorders the rule parts; what matters is a DATE-typed UNTIL.
		const series = await stored(uid);
		expect(series.events[0]?.recurrence?.split(";")).toContain(
			"UNTIL=20261229"
		);

		await update({ recurrenceId: "2026-10-13", title: "Gym (short)", uid });
		const edited = await stored(uid);
		expect(edited.raw).toContain("RECURRENCE-ID;VALUE=DATE:20261013");
		const override = edited.events.find((e) => e.recurrenceId !== undefined);
		expect(override).toMatchObject({
			allDay: true,
			end: "2026-10-14",
			start: "2026-10-13",
			title: "Gym (short)",
		});
		// The override inherits the series' reminder; the master keeps its own.
		expect(edited.events.map((e) => e.alarms?.length)).toEqual([1, 1]);
		expect(edited.events.find((e) => e.recurrence)?.title).toBe("Gym");

		// Cancelling one day writes a DATE EXDATE Stalwart accepts, and keeps the override.
		const cancelled = await deleteCalendarEvent(makeDeleteDeps(cfg), {
			args: { recurrenceId: "2026-10-20", uid },
			token,
		});
		expect(cancelled.isError).toBeUndefined();
		const after = await stored(uid);
		expect(after.events.find((e) => e.recurrence)?.excludedDates).toEqual([
			"2026-10-20",
		]);
		expect(
			after.events.filter((e) => e.recurrenceId !== undefined)
		).toHaveLength(1);
	});

	test("a reminder-only edit keeps an accepted attendee accepted and SEQUENCE unchanged", async () => {
		const uid = await create({
			attendees: ["guest@example.com"],
			end: "2026-11-12T11:00:00",
			notify: "none",
			start: "2026-11-12T10:00:00",
			title: "Planning",
		});
		// Stand in for the guest's REPLY: mark them accepted on the stored object.
		const object = await fetchEvent(cfg, { calendarUrl, token, uid });
		if (!object) {
			throw new Error("event not stored");
		}
		await updateEvent(cfg, {
			ical: object.data.replace("PARTSTAT=NEEDS-ACTION", "PARTSTAT=ACCEPTED"),
			token,
			url: object.url,
			...(object.etag ? { etag: object.etag } : {}),
		});
		const before = await stored(uid);
		expect(before.events[0]?.attendees[0]?.status).toBe("ACCEPTED");

		await update({ reminderMinutesBefore: 15, uid });
		const after = await stored(uid);
		expect(after.events[0]?.attendees[0]?.status).toBe("ACCEPTED");
		expect(after.raw.match(SEQUENCE_RE)?.[0]).toBe(
			before.raw.match(SEQUENCE_RE)?.[0]
		);
		expect(await listed(uid)).toContain("reminder: 15 minutes before start");
	});
});
