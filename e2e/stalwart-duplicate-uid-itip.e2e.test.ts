// Regression guard for an upstream Stalwart defect (iTIP ingestion picks the
// first UID match), against a REAL Stalwart. CalDAV scopes UID uniqueness to one calendar, so a
// second client can leave the same invitation in two calendars of an account.
// Stalwart's `itip_ingest` then looks the UID up account-wide and applies an
// incoming update to the first match only; the other copy silently keeps the
// old state. This test asserts exactly that — so it turns red when an update
// reaches both copies or the duplicate is refused.
//
// Skips unless STALWART_ADMIN_URL is set; see e2e/README.md.

import { afterAll, beforeAll, expect, test } from "vitest";
import {
	createCalendar,
	fetchEvent,
	fetchEvents,
	putEvent,
} from "../src/caldav/client.ts";
import { parseEvents } from "../src/ical/index.ts";
import { destroyCreatedAccounts } from "./support/admin.ts";
import {
	messageCount,
	type Principal,
	provisionPrincipal,
	waitForMoreThan,
} from "./support/caldav.ts";
import { live } from "./support/env.ts";
import { pollUntil, sleep } from "./support/wait.ts";

const get = async (p: Principal, url: string) => {
	const res = await fetch(url, { headers: { authorization: p.basic } });
	return {
		body: await res.text(),
		etag: res.headers.get("etag"),
		status: res.status,
	};
};

const STAMP_SEPARATORS_RE = /[-:]/gu;
const MILLIS_RE = /\.\d{3}/u;
const SEQUENCE_RE = /SEQUENCE:(\d+)/u;
const stamp = (d: Date): string =>
	d.toISOString().replace(STAMP_SEPARATORS_RE, "").replace(MILLIS_RE, "");

// A future Tuesday 10:00Z, far enough out that Stalwart treats it as schedulable.
const futureStart = (): Date => {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + 35 + ((9 - d.getUTCDay()) % 7 || 7));
	d.setUTCHours(10, 0, 0, 0);
	return d;
};

const invite = (
	uid: string,
	org: Principal,
	att: Principal,
	title: string
): string => {
	const start = futureStart();
	const end = new Date(start.getTime() + 3_600_000);
	return `${[
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//langmail//duplicate-uid-e2e//EN",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		`DTSTAMP:${stamp(new Date())}`,
		`DTSTART:${stamp(start)}`,
		`DTEND:${stamp(end)}`,
		`SUMMARY:${title}`,
		`ORGANIZER:mailto:${org.addr}`,
		`ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${att.addr}`,
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n")}\r\n`;
};

const titlesFor = async (
	p: Principal,
	calendarUrl: string,
	uid: string
): Promise<string[]> =>
	(await fetchEvents(p.cfg, { calendarUrl, token: p.token }))
		.flatMap((o) => parseEvents(o.data))
		.filter((e) => e.uid === uid)
		.map((e) => e.title);

live(
	"iTIP ingestion with one UID in two calendars (upstream regression guard)",
	() => {
		const run = Date.now();
		let org: Principal;
		let att: Principal;
		let attSecond: string;

		beforeAll(async () => {
			org = await provisionPrincipal("dup-org", {
				localPart: `dup-org-${run}`,
			});
			att = await provisionPrincipal("dup-att", {
				localPart: `dup-att-${run}`,
			});
			attSecond = await createCalendar(att.cfg, {
				name: "Second",
				token: att.token,
			});
		});

		afterAll(destroyCreatedAccounts);

		test("an organizer update reaches only one of the two copies", async () => {
			const uid = `dup-uid-update-${run}@mcp-e2e`;
			const before = await messageCount(att);
			await putEvent(org.cfg, {
				calendarUrl: org.defaultUrl,
				ical: invite(uid, org, att, "Review"),
				token: org.token,
			});
			expect(await waitForMoreThan(att, before)).toBe(true);

			// Stalwart files the invitation in the attendee's default calendar.
			let attUrl: string | null = null;
			for (let i = 0; i < 60 && !attUrl; i += 1) {
				attUrl =
					(
						await fetchEvent(att.cfg, {
							calendarUrl: att.defaultUrl,
							token: att.token,
							uid,
						})
					)?.url ?? null;
				if (!attUrl) {
					await sleep(1000);
				}
			}
			expect(attUrl).not.toBeNull();

			// A second client files a copy of the same invitation in another calendar.
			const copy = await get(att, attUrl as string);
			const dup = await fetch(`${attSecond}${crypto.randomUUID()}.ics`, {
				body: copy.body,
				headers: {
					authorization: att.basic,
					"content-type": "text/calendar; charset=utf-8",
					"if-none-match": "*",
				},
				method: "PUT",
			});
			expect(dup.status).toBe(201);

			// The organizer renames the event; Stalwart delivers the REQUEST.
			const orgUrl = (
				await fetchEvent(org.cfg, {
					calendarUrl: org.defaultUrl,
					token: org.token,
					uid,
				})
			)?.url;
			expect(orgUrl).toBeDefined();
			const orgObj = await get(org, orgUrl as string);
			const renamed = orgObj.body.replace(
				"SUMMARY:Review\r\n",
				"SUMMARY:Review (moved to Friday)\r\n"
			);
			expect(renamed).not.toBe(orgObj.body);
			const updated = renamed.includes("SEQUENCE:")
				? renamed.replace(
						SEQUENCE_RE,
						(_m, n: string) => `SEQUENCE:${Number(n) + 1}`
					)
				: renamed.replace("SUMMARY:", "SEQUENCE:1\r\nSUMMARY:");
			const baseline = await messageCount(att);
			const put = await fetch(orgUrl as string, {
				body: updated,
				headers: {
					authorization: org.basic,
					"content-type": "text/calendar; charset=utf-8",
					...(orgObj.etag ? { "if-match": orgObj.etag } : {}),
				},
				method: "PUT",
			});
			expect(put.status).toBe(204);
			expect(await waitForMoreThan(att, baseline)).toBe(true);
			const readTitles = async (): Promise<string[]> =>
				[
					...(await titlesFor(att, att.defaultUrl, uid)),
					...(await titlesFor(att, attSecond, uid)),
				].sort();
			// The mail can arrive before the calendar copy is rewritten: wait until
			// the update shows in one copy, then give the other copy time to follow.
			await pollUntil(
				readTitles,
				(seen) => seen.includes("Review (moved to Friday)"),
				{
					intervalMs: 500,
					timeoutMs: 60_000,
					waitingFor: "the update to reach one copy",
				}
			);
			await sleep(3000);

			const titles = await readTitles();
			// The defect: one copy carries the update, the other keeps the old title.
			expect(titles).toEqual(["Review", "Review (moved to Friday)"]);
		}, 300_000);
	}
);
