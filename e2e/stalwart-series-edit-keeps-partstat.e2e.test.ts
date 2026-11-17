// E2E against a REAL Stalwart: a detail edit of a series made
// through update_calendar_event keeps every attendee's reply (RFC 5546
// §3.2.2.2), and only a reschedule asks them to answer again.
//
// Before the fix, the whole-series rebuild wrote every ATTENDEE back as
// PARTSTAT=NEEDS-ACTION. Stalwart then saw changed attendee parameters, bumped
// SEQUENCE a second time (0 → 2) and sent a REQUEST carrying NEEDS-ACTION,
// which reset the attendee's own copy too.
//
// It provisions two throwaway accounts: an organizer and a LOCAL
// attendee. The organizer seeds a weekly series; the attendee accepts it by
// flipping the PARTSTAT in their own copy, which Stalwart turns into a REPLY
// merged into the organizer's copy. Then the real update tool (live deps) edits
// only the description, and later moves the start.
//
// Skips unless STALWART_ADMIN_URL is set; see e2e/README.md.

import { afterAll, beforeAll, expect, test } from "vitest";
import { fetchEvent, putEvent } from "../src/caldav/client.ts";
import { buildInvite, parseSequence } from "../src/caldav/ical.ts";
import { parseEvents } from "../src/ical/index.ts";
import {
	makeLiveDeps,
	updateCalendarEvent,
} from "../src/tools/update-calendar-event.ts";
import { destroyCreatedAccounts } from "./support/admin.ts";
import { type Principal, provisionPrincipal } from "./support/caldav.ts";
import { live } from "./support/env.ts";
import { sleep } from "./support/wait.ts";

// 10:00Z on a Tuesday comfortably in the future, so Stalwart treats the series
// as schedulable and the run date never catches up with it.
const nextTuesday = (): Date => {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + 28 + ((9 - d.getUTCDay()) % 7 || 7));
	d.setUTCHours(10, 0, 0, 0);
	return d;
};

const PARTSTAT_RE = /PARTSTAT=[A-Z-]+/u;
const FOLD_RE = /\r?\n[ \t]/gu;
const NEWLINE_RE = /\r?\n/u;

// Deliveries between accounts take a second or two, longer on a loaded server.
const COPY_POLLS = 60;

// Polls the principal's copy of `uid` until `done` holds, returning the last
// raw object either way (null when it never arrived).
const copyUntil = async (
	p: Principal,
	uid: string,
	done: (ical: string) => boolean
): Promise<string | null> => {
	let last: string | null = null;
	for (let i = 0; i < COPY_POLLS; i += 1) {
		const found = await fetchEvent(p.cfg, {
			calendarUrl: p.defaultUrl,
			token: p.token,
			uid,
		});
		last = found?.data ?? null;
		if (last !== null && done(last)) {
			return last;
		}
		await sleep(1000);
	}
	return last;
};

// The master's PARTSTAT for `addr` in a stored object.
const partstatOf = (ical: string, addr: string): string | undefined =>
	parseEvents(ical)
		.find((e) => e.recurrenceId === undefined)
		?.attendees.find((a) => a.email.toLowerCase() === addr.toLowerCase())
		?.status;

// The attendee accepts the series by flipping their own PARTSTAT in their copy;
// Stalwart sends the REPLY to the organizer's account.
const acceptSeries = async (p: Principal, uid: string): Promise<void> => {
	const found = await fetchEvent(p.cfg, {
		calendarUrl: p.defaultUrl,
		token: p.token,
		uid,
	});
	if (!found) {
		throw new Error(`${p.addr} never received ${uid}`);
	}
	const unfolded = found.data.replace(FOLD_RE, "");
	const accepted = unfolded
		.split(NEWLINE_RE)
		.map((l) =>
			l.startsWith("ATTENDEE") && l.toLowerCase().endsWith(`:mailto:${p.addr}`)
				? l.replace(PARTSTAT_RE, "PARTSTAT=ACCEPTED")
				: l
		)
		.join("\r\n");
	const res = await fetch(found.url, {
		body: accepted,
		headers: {
			authorization: p.basic,
			"content-type": "text/calendar; charset=utf-8",
			...(found.etag ? { "if-match": found.etag } : {}),
		},
		method: "PUT",
	});
	if (res.status >= 300) {
		throw new Error(`attendee PUT returned HTTP ${res.status}`);
	}
};

live(
	"update_calendar_event keeps attendee replies against live Stalwart",
	() => {
		const run = Date.now();
		let org: Principal;
		let guest: Principal;

		beforeAll(async () => {
			org = await provisionPrincipal("kp-org", {
				localPart: `kp-org-${run}`,
			});
			guest = await provisionPrincipal("kp-guest", {
				localPart: `kp-guest-${run}`,
			});
		});

		afterAll(destroyCreatedAccounts);

		test("a description-only edit keeps ACCEPTED and SEQUENCE; a start change resets the reply", async () => {
			const uid = `keeps-partstat-${run}@mcp-e2e`;
			const start = nextTuesday();
			await putEvent(org.cfg, {
				calendarUrl: org.defaultUrl,
				ical: buildInvite({
					attendees: [guest.addr],
					end: new Date(start.getTime() + 1_800_000),
					organizer: org.organizer,
					rrule: "FREQ=WEEKLY;BYDAY=TU",
					start,
					title: "Weekly sync",
					uid,
				}),
				token: org.token,
			});

			// Wait for the invite, accept it, and wait for the REPLY to land.
			expect(await copyUntil(guest, uid, () => true)).not.toBeNull();
			await acceptSeries(guest, uid);
			const replied = await copyUntil(
				org,
				uid,
				(ical) => partstatOf(ical, guest.addr) === "ACCEPTED"
			);
			expect(partstatOf(replied ?? "", guest.addr)).toBe("ACCEPTED");
			const sequenceBefore = parseSequence(replied ?? "");

			const edited = await updateCalendarEvent(makeLiveDeps(org.cfg), {
				args: { description: "Agenda: roadmap", uid },
				token: org.token,
			});
			expect(edited.isError).toBeUndefined();

			const orgCopy = await copyUntil(org, uid, (ical) =>
				ical.includes("Agenda: roadmap")
			);
			expect(partstatOf(orgCopy ?? "", guest.addr)).toBe("ACCEPTED");
			expect(parseSequence(orgCopy ?? "")).toBe(sequenceBefore);

			// The REQUEST still reaches the attendee and carries their own reply.
			const guestCopy = await copyUntil(guest, uid, (ical) =>
				ical.includes("Agenda: roadmap")
			);
			expect(guestCopy).toContain("Agenda: roadmap");
			expect(partstatOf(guestCopy ?? "", guest.addr)).toBe("ACCEPTED");

			// A reschedule is the one edit that asks everyone to answer again.
			const moved = await updateCalendarEvent(makeLiveDeps(org.cfg), {
				args: {
					start: new Date(start.getTime() + 3_600_000).toISOString(),
					uid,
				},
				token: org.token,
			});
			expect(moved.isError).toBeUndefined();
			const movedCopy = await copyUntil(
				org,
				uid,
				(ical) => parseSequence(ical) > sequenceBefore
			);
			expect(partstatOf(movedCopy ?? "", guest.addr)).toBe("NEEDS-ACTION");
		}, 300_000);
	}
);
