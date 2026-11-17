// Regression guard for the iTIP REPLY merge of ONE instance of a recurring
// series, against a REAL Stalwart.
//
// Through 0.16, when a REPLY named an instance (RECURRENCE-ID) with no override
// VEVENT in the organizer's stored object yet, Stalwart appended a stub built
// from the REPLY alone — no DTSTART, no SUMMARY, none of the other attendees —
// and then rejected every further attendee's REPLY for that instance with
// `Sender "<email>" is not a participant`. Stalwart 1.0 builds the override
// from the master and merges each REPLY into it. The first test pins that
// fixed behaviour, so a regression turns it red; the control covers an
// instance the organizer had already overridden, which worked on both.
//
// It provisions three throwaway accounts: an organizer and two LOCAL
// attendees. Each attendee answers one instance by PUTting a PARTSTAT override
// into their own copy; Stalwart's attendee path turns that into a REPLY with a
// RECURRENCE-ID and delivers it into the organizer's account through the same
// `itip_ingest` → `handle_reply` path an external (iMIP over SMTP) REPLY takes.
// External delivery is not used because Stalwart only ingests iMIP from
// authenticated or DMARC-passing senders, which an example.com sender can't be.
//
// Skips unless STALWART_ADMIN_URL is set; see e2e/README.md.

import { afterAll, beforeAll, expect, test } from "vitest";

import { fetchEvent, putEvent } from "../src/caldav/client.ts";
import { adminCall, destroyCreatedAccounts } from "./support/admin.ts";
import { type Principal, provisionPrincipal } from "./support/caldav.ts";
import { ADMIN_URL, live } from "./support/env.ts";
import { sleep } from "./support/wait.ts";

const TZID = "Europe/Berlin";
// Wall-clock start/end of the series' instances. An attendee's accept override
// must repeat them exactly, or Stalwart sees a time change instead of a
// PARTSTAT edit. (The control test moves one instance on purpose.)
const START = "T100000";
const END = "T110000";

// Undo RFC 5545 line folding so property matching isn't fooled by a fold.
const unfold = (ical: string): string => ical.replace(/\r?\n[ \t]/gu, "");

const STAMP_SEPARATORS_RE = /[-:]/gu;
const MILLIS_RE = /\.\d{3}/u;
const VEVENT_RE = /BEGIN:VEVENT\r?\n[\s\S]*?END:VEVENT\r?\n?/gu;
const PARTSTAT_RE = /PARTSTAT=[A-Z-]+/u;
const NEWLINE_RE = /\r?\n/u;
const PROP_NAME_END_RE = /[;:]/u;
const stamp = (d: Date): string =>
	d.toISOString().replace(STAMP_SEPARATORS_RE, "").replace(MILLIS_RE, "");

// YYYYMMDD of a Tuesday `weeksOut` weeks after a base Tuesday comfortably in
// the future, so Stalwart treats every instance as schedulable.
const tuesday = (weeksOut: number): string => {
	const d = new Date();
	d.setUTCDate(
		d.getUTCDate() + 28 + ((9 - d.getUTCDay()) % 7 || 7) + weeksOut * 7
	);
	return d.toISOString().slice(0, 10).replaceAll("-", "");
};

const VTIMEZONE = [
	"BEGIN:VTIMEZONE",
	`TZID:${TZID}`,
	"BEGIN:DAYLIGHT",
	"TZOFFSETFROM:+0100",
	"TZOFFSETTO:+0200",
	"TZNAME:CEST",
	"DTSTART:19700329T020000",
	"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
	"END:DAYLIGHT",
	"BEGIN:STANDARD",
	"TZOFFSETFROM:+0200",
	"TZOFFSETTO:+0100",
	"TZNAME:CET",
	"DTSTART:19701025T030000",
	"RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
	"END:STANDARD",
	"END:VTIMEZONE",
];

const series = (uid: string, org: Principal, attendees: Principal[]): string =>
	`${[
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//langmail//reply-instance-e2e//EN",
		...VTIMEZONE,
		"BEGIN:VEVENT",
		`UID:${uid}`,
		`DTSTAMP:${stamp(new Date())}`,
		`DTSTART;TZID=${TZID}:${tuesday(0)}${START}`,
		`DTEND;TZID=${TZID}:${tuesday(0)}${END}`,
		"RRULE:FREQ=WEEKLY;BYDAY=TU",
		"SUMMARY:Weekly sync",
		"SEQUENCE:0",
		`ORGANIZER:mailto:${org.addr}`,
		...attendees.map(
			(a) => `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.addr}`
		),
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n")}\r\n`;

interface StoredObject {
	body: string;
	etag: string | null;
	url: string;
}

// Polls until the principal's default calendar holds the UID, then GETs it raw
// (with its ETag) for a conditional PUT.
const loadObject = async (p: Principal, uid: string): Promise<StoredObject> => {
	for (let i = 0; i < 60; i += 1) {
		const found = await fetchEvent(p.cfg, {
			calendarUrl: p.defaultUrl,
			token: p.token,
			uid,
		});
		if (found) {
			const res = await fetch(found.url, {
				headers: { authorization: p.basic },
			});
			return {
				body: unfold(await res.text()),
				etag: res.headers.get("etag"),
				url: found.url,
			};
		}
		await sleep(1000);
	}
	throw new Error(`${p.addr} never received ${uid}`);
};

const putRaw = async (
	p: Principal,
	obj: StoredObject,
	body: string
): Promise<number> => {
	const res = await fetch(obj.url, {
		body,
		headers: {
			authorization: p.basic,
			"content-type": "text/calendar; charset=utf-8",
			...(obj.etag ? { "if-match": obj.etag } : {}),
		},
		method: "PUT",
	});
	return res.status;
};

const vevents = (ical: string): string[] => ical.match(VEVENT_RE) ?? [];

const lines = (vevent: string): string[] =>
	vevent.split(NEWLINE_RE).filter(Boolean);

const instanceOf = (ical: string, recurrenceId: string): string | undefined =>
	vevents(ical).find((v) =>
		lines(v).some(
			(l) => l.startsWith("RECURRENCE-ID") && l.endsWith(`:${recurrenceId}`)
		)
	);

const masterOf = (ical: string): string => {
	const master = vevents(ical).find(
		(v) => !lines(v).some((l) => l.startsWith("RECURRENCE-ID"))
	);
	if (!master) {
		throw new Error("no master VEVENT");
	}
	return master;
};

// Shape of one VEVENT, for assertions and for the run log: property names and
// the attendees with their PARTSTAT.
interface Shape {
	attendees: string[];
	props: string[];
}
const shapeOf = (vevent: string): Shape => {
	const props = lines(vevent)
		.filter((l) => !(l.startsWith("BEGIN:") || l.startsWith("END:")))
		.map((l) => l.split(PROP_NAME_END_RE)[0] ?? l);
	const attendees = lines(vevent)
		.filter((l) => l.startsWith("ATTENDEE"))
		.map(
			(l) =>
				`${l.slice(l.lastIndexOf(":") + 1).toLowerCase()} ${l.match(PARTSTAT_RE)?.[0] ?? "PARTSTAT=?"}`
		);
	return { attendees, props: [...new Set(props)] };
};

const withPartstat = (vevent: string, addr: string, partstat: string): string =>
	lines(vevent)
		.map((l) =>
			l.startsWith("ATTENDEE") && l.toLowerCase().endsWith(`:mailto:${addr}`)
				? l.replace(PARTSTAT_RE, `PARTSTAT=${partstat}`)
				: l
		)
		.join("\r\n");

// The attendee accepts ONE instance by adding an override VEVENT (copied from
// their master, RRULE dropped, RECURRENCE-ID added) with their PARTSTAT flipped.
const acceptNewInstance = async (
	p: Principal,
	uid: string,
	day: string
): Promise<number> => {
	const obj = await loadObject(p, uid);
	const master = masterOf(obj.body);
	const override = `${lines(withPartstat(master, p.addr, "ACCEPTED"))
		.filter(
			(l) =>
				!(
					l.startsWith("RRULE") ||
					l.startsWith("DTSTART") ||
					l.startsWith("DTEND")
				)
		)
		.flatMap((l) =>
			l === "BEGIN:VEVENT"
				? [
						l,
						`RECURRENCE-ID;TZID=${TZID}:${day}${START}`,
						`DTSTART;TZID=${TZID}:${day}${START}`,
						`DTEND;TZID=${TZID}:${day}${END}`,
					]
				: [l]
		)
		.join("\r\n")}\r\n`;
	return putRaw(
		p,
		obj,
		obj.body.replace("END:VCALENDAR", `${override}END:VCALENDAR`)
	);
};

// The attendee accepts an instance that already has an override in their copy.
const acceptExistingInstance = async (
	p: Principal,
	uid: string,
	recurrenceId: string
): Promise<number> => {
	const obj = await loadObject(p, uid);
	const override = instanceOf(obj.body, recurrenceId);
	if (!override) {
		throw new Error(`${p.addr} has no override for ${recurrenceId}`);
	}
	return putRaw(
		p,
		obj,
		obj.body.replace(
			override,
			`${withPartstat(override, p.addr, "ACCEPTED")}\r\n`
		)
	);
};

interface JmapSession {
	apiUrl: string;
	primaryAccounts: Record<string, string>;
}

// What a missing iTIP delivery leaves behind. Stalwart 1.0 sends a local
// attendee the organizer's change as iMIP mail through its queue, and skips
// iTIP processing for mail it files as spam. So: the attendee's latest mail
// with its folder and spam verdict, and what the queue still holds.
const deliveryReport = async (p: Principal): Promise<string> => {
	const sessionRes = await fetch(`${ADMIN_URL}/jmap/session`, {
		headers: { authorization: p.basic },
	});
	const session = (await sessionRes.json()) as JmapSession;
	const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
	const mailRes = await fetch(session.apiUrl, {
		body: JSON.stringify({
			methodCalls: [
				["Mailbox/get", { accountId, properties: ["name", "role"] }, "m"],
				[
					"Email/query",
					{
						accountId,
						limit: 20,
						sort: [{ isAscending: false, property: "receivedAt" }],
					},
					"q",
				],
				[
					"Email/get",
					{
						"#ids": { name: "Email/query", path: "/ids", resultOf: "q" },
						accountId,
						properties: [
							"subject",
							"mailboxIds",
							"receivedAt",
							"header:X-Spam-Status:asText",
						],
					},
					"g",
				],
			],
			using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
		}),
		headers: { authorization: p.basic, "content-type": "application/json" },
		method: "POST",
	});
	const mail = (await mailRes.json()) as { methodResponses?: unknown[] };
	const queue = await adminCall("x:QueuedMessage/query", {});
	const queued = (queue.ids as string[] | undefined) ?? [];
	const held = queued.length
		? await adminCall("x:QueuedMessage/get", { ids: queued.slice(0, 10) })
		: {};
	return JSON.stringify({
		mail: mail.methodResponses,
		queue: { held, total: queued.length },
	});
};

// Polls until the organizer's override reaches the attendee's copy. Its own
// failure tells a slow iTIP delivery apart from an override that arrived and
// was later lost, which `acceptExistingInstance` would report the same way.
const attendeeUntilOverride = async (
	p: Principal,
	uid: string,
	recurrenceId: string
): Promise<void> => {
	for (let i = 0; i < 90; i += 1) {
		if (instanceOf((await loadObject(p, uid)).body, recurrenceId)) {
			return;
		}
		await sleep(1000);
	}
	throw new Error(
		`${p.addr} never received the organizer's override for ${recurrenceId}: ${await deliveryReport(p)}`
	);
};

// Polls the organizer's object until `done` holds, or gives up and returns the
// last state — the defect leaves the second reply unmerged forever.
const organizerUntil = async (
	org: Principal,
	uid: string,
	done: (ical: string) => boolean
): Promise<string> => {
	let last = "";
	for (let i = 0; i < 45; i += 1) {
		last = (await loadObject(org, uid)).body;
		if (done(last)) {
			return last;
		}
		await sleep(1000);
	}
	return last;
};

const accepted = (vevent: string | undefined, addr: string): boolean =>
	shapeOf(vevent ?? "").attendees.includes(
		`${addr.toLowerCase()} PARTSTAT=ACCEPTED`
	);

live(
	"iTIP REPLY for one instance of a recurring series (upstream regression guard)",
	() => {
		const run = Date.now();
		let org: Principal;
		let attA: Principal;
		let attB: Principal;

		beforeAll(async () => {
			org = await provisionPrincipal("reply-org", {
				localPart: `reply-org-${run}`,
			});
			attA = await provisionPrincipal("reply-a", {
				localPart: `reply-a-${run}`,
			});
			attB = await provisionPrincipal("reply-b", {
				localPart: `reply-b-${run}`,
			});
		});

		afterAll(destroyCreatedAccounts);

		test("a REPLY for a never-modified instance builds the override from the master, and a second REPLY lands", async () => {
			const uid = `reply-unmodified-${run}@mcp-e2e`;
			const day = tuesday(2);
			const recurrenceId = `${day}${START}`;
			await putEvent(org.cfg, {
				calendarUrl: org.defaultUrl,
				ical: series(uid, org, [attA, attB]),
				token: org.token,
			});
			await loadObject(org, uid);

			expect(await acceptNewInstance(attA, uid, day)).toBe(204);
			const afterA = await organizerUntil(org, uid, (ical) =>
				accepted(instanceOf(ical, recurrenceId), attA.addr)
			);

			// Fixed in 1.0, part 1: the new instance is a full override built from the
			// master — its time, its summary and every attendee — not a stub of the
			// REPLY's identity properties.
			const override = shapeOf(instanceOf(afterA, recurrenceId) ?? "");
			expect(override.props).toContain("RECURRENCE-ID");
			expect(override.props).toContain("DTSTART");
			expect(override.props).toContain("SUMMARY");
			expect(override.attendees).toEqual([
				`${attA.addr.toLowerCase()} PARTSTAT=ACCEPTED`,
				`${attB.addr.toLowerCase()} PARTSTAT=NEEDS-ACTION`,
			]);

			expect(await acceptNewInstance(attB, uid, day)).toBe(204);
			const afterB = await organizerUntil(org, uid, (ical) =>
				accepted(instanceOf(ical, recurrenceId), attB.addr)
			);

			// Fixed in 1.0, part 2: B's REPLY for the same instance is merged.
			expect(accepted(instanceOf(afterB, recurrenceId), attB.addr)).toBe(true);
			expect(accepted(instanceOf(afterB, recurrenceId), attA.addr)).toBe(true);
		}, 300_000);

		test("control: REPLYs for an instance the organizer already overrode both land", async () => {
			const uid = `reply-overridden-${run}@mcp-e2e`;
			const day = tuesday(3);
			const recurrenceId = `${day}${START}`;
			await putEvent(org.cfg, {
				calendarUrl: org.defaultUrl,
				ical: series(uid, org, [attA, attB]),
				token: org.token,
			});
			// Stalwart queues each iTIP message on its own, so an update sent right
			// after the invite can arrive first, and the invite then drops it. So
			// wait until both attendees hold the invite.
			for (const att of [attA, attB]) {
				await loadObject(att, uid);
			}

			// The organizer moves the instance two hours later — a full override.
			const orgObj = await loadObject(org, uid);
			const moved = `${lines(masterOf(orgObj.body))
				.filter(
					(l) =>
						!(
							l.startsWith("RRULE") ||
							l.startsWith("DTSTART") ||
							l.startsWith("DTEND") ||
							l.startsWith("SUMMARY")
						)
				)
				.flatMap((l) =>
					l === "BEGIN:VEVENT"
						? [
								l,
								`RECURRENCE-ID;TZID=${TZID}:${recurrenceId}`,
								`DTSTART;TZID=${TZID}:${day}T120000`,
								`DTEND;TZID=${TZID}:${day}T130000`,
								"SUMMARY:Weekly sync (moved)",
							]
						: [l]
				)
				.join("\r\n")}\r\n`;
			expect(
				await putRaw(
					org,
					orgObj,
					orgObj.body.replace("END:VCALENDAR", `${moved}END:VCALENDAR`)
				)
			).toBe(204);

			// Wait for the override to reach both attendees' copies.
			for (const att of [attA, attB]) {
				await attendeeUntilOverride(att, uid, recurrenceId);
			}

			expect(await acceptExistingInstance(attA, uid, recurrenceId)).toBe(204);
			const afterA = await organizerUntil(org, uid, (ical) =>
				accepted(instanceOf(ical, recurrenceId), attA.addr)
			);
			expect(accepted(instanceOf(afterA, recurrenceId), attA.addr)).toBe(true);
			expect(await acceptExistingInstance(attB, uid, recurrenceId)).toBe(204);
			const afterB = await organizerUntil(org, uid, (ical) =>
				accepted(instanceOf(ical, recurrenceId), attB.addr)
			);

			const override = shapeOf(instanceOf(afterB, recurrenceId) ?? "");
			expect(override.props).toContain("DTSTART");
			expect(override.props).toContain("SUMMARY");
			expect(accepted(instanceOf(afterB, recurrenceId), attA.addr)).toBe(true);
			expect(accepted(instanceOf(afterB, recurrenceId), attB.addr)).toBe(true);
		}, 300_000);
	}
);
