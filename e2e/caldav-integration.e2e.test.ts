// Integration tests for the CalDAV adapter against a *real* server.
//
// Our unit tests mock the tool `Deps`, so the tsdav-backed client in
// client.ts — REPORT/multiget, PUT/DELETE, URL + filename handling — is
// never exercised. That's exactly where the "delete 404s" bug lived: we
// assumed the stored object is named `${uid}.ics`. These tests drive the
// live client against Stalwart with a fresh account, including the
// filename≠UID regression. The account's credential (a Basic `Authorization`
// value) is passed as the token and reaches the server unchanged: no
// `authHeaders` override is involved.
//
// Skips unless STALWART_ADMIN_URL is set; see e2e/README.md.

import { createCalendarObject } from "tsdav";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
	type CalDavConfig,
	createCalendar,
	deleteEvent,
	fetchCalendarList,
	fetchEvent,
	fetchEvents,
	putEvent,
	updateEvent,
	withTrailingSlash,
} from "../src/caldav/client.ts";
import { buildInvite } from "../src/caldav/ical.ts";
import { spliceOccurrenceOverride } from "../src/caldav/occurrence.ts";
import { parseEvents } from "../src/ical/index.ts";
import {
	deleteCalendarEvent,
	makeLiveDeps as makeDeleteDeps,
} from "../src/tools/delete-calendar-event.ts";
import {
	listCalendarEvents,
	makeLiveDeps as makeListDeps,
} from "../src/tools/list-calendar-events.ts";
import {
	makeLiveDeps as makeRespondDeps,
	respondToEvent,
} from "../src/tools/respond-to-event.ts";
import { destroyCreatedAccounts } from "./support/admin.ts";
import { provisionPrincipal } from "./support/caldav.ts";
import { ADMIN_URL, live } from "./support/env.ts";

const LINE_BREAK_RE = /\r?\n/u;
const UUID_ICS_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ics$/u;

live("caldav client against a live server", () => {
	const base = ADMIN_URL;
	const cfg: CalDavConfig = { serverUrl: base };
	// The account's credential: the complete Authorization header value. The
	// client and the tools take it as `token`; raw requests send it as is.
	let token: string;
	let basic: string;
	// The account's own address.
	let me: string;
	// The account's calendar home, e.g. `…/dav/cal/<address>/`.
	let home: string;
	let calendarUrl: string;

	const invite = (uid: string, title: string, rrule?: string): string =>
		buildInvite({
			attendees: ["guest@example.com"],
			end: new Date("2026-06-12T10:30:00Z"),
			organizer: me,
			start: new Date("2026-06-12T10:00:00Z"),
			title,
			uid,
			...(rrule ? { rrule } : {}),
		});

	beforeAll(async () => {
		const principal = await provisionPrincipal("caldav-it");
		({ basic, token } = principal);
		me = principal.addr;
		const defaultUrl = withTrailingSlash(principal.defaultUrl);
		home = defaultUrl.slice(0, defaultUrl.slice(0, -1).lastIndexOf("/") + 1);
		calendarUrl = `${home}mcp-it/`;
		// Provision the calendar collection the tests share. Anything but 201 is
		// a real setup failure (bad URL or auth) worth surfacing here rather than
		// as confusing 404s in every test.
		const res = await fetch(calendarUrl, {
			headers: { authorization: basic },
			method: "MKCALENDAR",
		});
		if (res.status !== 201) {
			throw new Error(`MKCALENDAR ${calendarUrl} failed: ${res.status}`);
		}
	});

	afterAll(destroyCreatedAccounts);

	test("create → fetch → update → delete round-trips", async () => {
		const uid = `lifecycle-${Date.now()}@mcp-it`;
		await putEvent(cfg, {
			calendarUrl,
			ical: invite(uid, "Original"),
			token,
		});

		const created = await fetchEvent(cfg, { calendarUrl, token, uid });
		expect(created).not.toBeNull();
		expect(created?.data).toContain("SUMMARY:Original");

		await updateEvent(cfg, {
			ical: invite(uid, "Updated"),
			token,
			url: created?.url ?? "",
			...(created?.etag ? { etag: created.etag } : {}),
		});

		const updated = await fetchEvent(cfg, { calendarUrl, token, uid });
		expect(updated?.data).toContain("SUMMARY:Updated");

		await deleteEvent(cfg, {
			token,
			url: updated?.url ?? "",
			...(updated?.etag ? { etag: updated.etag } : {}),
		});
		expect(await fetchEvent(cfg, { calendarUrl, token, uid })).toBeNull();
	});

	// Recurrence (RRULE) round-trip against the real server: a recurring VEVENT
	// must survive the PUT, come back with its RRULE intact, surface as `repeats:`
	// through the list tool, and re-rule cleanly on update. Unit tests only prove
	// we *emit* the RRULE — this proves Stalwart stores and returns it intact.
	test("recurring event round-trips its RRULE through create → list → update → delete", async () => {
		const uid = `recurring-${Date.now()}@mcp-it`;
		await putEvent(cfg, {
			calendarUrl,
			ical: invite(uid, "Weekly sync", "FREQ=WEEKLY;BYDAY=TH"),
			token,
		});

		const created = await fetchEvent(cfg, { calendarUrl, token, uid });
		expect(created?.data).toContain("RRULE:FREQ=WEEKLY;BYDAY=TH");

		// The list tool parses the stored RRULE back out and renders it as `repeats:`.
		const list = await listCalendarEvents(makeListDeps(cfg), {
			args: { calendarUrl },
			token,
		});
		expect(list.content[0]?.text).toContain("repeats: FREQ=WEEKLY;BYDAY=TH");

		// Re-rule the whole series (here: weekdays, bounded by COUNT). The new rule
		// must replace the old one, not accumulate a second RRULE line.
		await updateEvent(cfg, {
			ical: invite(uid, "Weekly sync", "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=12"),
			token,
			url: created?.url ?? "",
			...(created?.etag ? { etag: created.etag } : {}),
		});

		const updated = await fetchEvent(cfg, { calendarUrl, token, uid });
		// Stalwart re-serializes the rule with its parts in its own order
		// (COUNT before BYDAY), so compare the parts, not the line.
		const rules = (updated?.data ?? "")
			.split(LINE_BREAK_RE)
			.filter((line) => line.startsWith("RRULE:"));
		expect(rules).toHaveLength(1);
		expect(rules[0]?.slice("RRULE:".length).split(";").sort()).toEqual([
			"BYDAY=MO,WE,FR",
			"COUNT=12",
			"FREQ=WEEKLY",
		]);
		expect(updated?.data).not.toContain("FREQ=WEEKLY;BYDAY=TH");

		await deleteEvent(cfg, {
			token,
			url: updated?.url ?? "",
			...(updated?.etag ? { etag: updated.etag } : {}),
		});
		expect(await fetchEvent(cfg, { calendarUrl, token, uid })).toBeNull();
	});

	// Cancelling one occurrence must NOT DELETE the resource: the master and the
	// other occurrences live in the same object. Prove against the real server
	// that the delete tool PUTs an EXDATE back (keeping the resource), that the
	// cancelled instant is excluded, and that a whole-series delete still 404s the
	// resource. (iMIP fan-out is out of scope here —
	// stalwart-cancel-occurrence.e2e.test.ts covers what the attendee receives.)
	test("cancels one occurrence via EXDATE (PUT, not DELETE); whole-series delete still 404s", async () => {
		const uid = `cancel-occurrence-${Date.now()}@mcp-it`;
		// Weekly on Tuesdays from 2026-06-16, so 2026-06-23T10:00:00Z is occurrence #2.
		await putEvent(cfg, {
			calendarUrl,
			ical: invite(uid, "Weekly sync", "FREQ=WEEKLY;BYDAY=TU"),
			token,
		});

		const occurrence = "2026-06-23T10:00:00Z";
		const cancelled = await deleteCalendarEvent(makeDeleteDeps(cfg), {
			args: { calendarUrl, recurrenceId: occurrence, uid },
			token,
		});
		expect(cancelled.isError).toBeUndefined();
		expect(cancelled.content[0]?.text).toContain("cancelled");

		// The resource survives and now carries the EXDATE alongside the untouched
		// master RRULE — and no override for the cancelled instant.
		const afterCancel = await fetchEvent(cfg, {
			calendarUrl,
			token,
			uid,
		});
		expect(afterCancel).not.toBeNull();
		expect(afterCancel?.data).toContain("EXDATE:20260623T100000Z");
		expect(afterCancel?.data).toContain("RRULE:FREQ=WEEKLY;BYDAY=TU");
		expect(afterCancel?.data).not.toContain("RECURRENCE-ID:20260623T100000Z");

		// Whole-series delete (no recurrenceId) removes the resource entirely.
		const wholeSeries = await deleteCalendarEvent(makeDeleteDeps(cfg), {
			args: { calendarUrl, uid },
			token,
		});
		expect(wholeSeries.isError).toBeUndefined();
		expect(await fetchEvent(cfg, { calendarUrl, token, uid })).toBeNull();
	});

	// The edited-then-cancelled shape: an occurrence is first overridden (a
	// RECURRENCE-ID VEVENT spliced beside the master), then cancelled. The cancel
	// must drop that override (so no orphan dangles beside the EXDATE) — unlike the
	// plain-series test above, here an override genuinely exists first, so the
	// "override is gone" assertion actually bites.
	test("cancelling an overridden occurrence drops the override and adds an EXDATE", async () => {
		const uid = `cancel-override-${Date.now()}@mcp-it`;
		await putEvent(cfg, {
			calendarUrl,
			ical: invite(uid, "Weekly sync", "FREQ=WEEKLY;BYDAY=TU"),
			token,
		});

		const occurrence = "2026-06-23T10:00:00Z";
		// Splice an override for that occurrence and PUT it back, so the stored object
		// carries master + one RECURRENCE-ID override.
		const series = await fetchEvent(cfg, { calendarUrl, token, uid });
		const override = buildInvite({
			attendees: ["guest@example.com"],
			end: new Date("2026-06-23T12:00:00Z"),
			organizer: me,
			recurrenceId: new Date(occurrence),
			sequence: 1,
			start: new Date("2026-06-23T11:00:00Z"),
			title: "Weekly sync (moved)",
			uid,
		});
		await updateEvent(cfg, {
			ical: spliceOccurrenceOverride(series?.data ?? "", override, occurrence),
			token,
			url: series?.url ?? "",
			...(series?.etag ? { etag: series.etag } : {}),
		});
		const withOverride = await fetchEvent(cfg, {
			calendarUrl,
			token,
			uid,
		});
		expect(withOverride?.data).toContain("RECURRENCE-ID:20260623T100000Z");

		// Cancel that occurrence: the override is dropped and an EXDATE takes its place.
		const cancelled = await deleteCalendarEvent(makeDeleteDeps(cfg), {
			args: { calendarUrl, recurrenceId: occurrence, uid },
			token,
		});
		expect(cancelled.isError).toBeUndefined();

		const afterCancel = await fetchEvent(cfg, {
			calendarUrl,
			token,
			uid,
		});
		expect(afterCancel?.data).toContain("EXDATE:20260623T100000Z");
		expect(afterCancel?.data).not.toContain("RECURRENCE-ID:20260623T100000Z");
		const events = parseEvents(afterCancel?.data ?? "");
		expect(events).toHaveLength(1);
		expect(events[0]?.recurrence).toBeDefined();

		await deleteEvent(cfg, {
			token,
			url: afterCancel?.url ?? "",
			...(afterCancel?.etag ? { etag: afterCancel.etag } : {}),
		});
	});

	test("finds and deletes an event whose filename differs from its UID (regression)", async () => {
		const uid = `mismatch-${Date.now()}@mcp-it`;
		// Store under a server-style name unrelated to the UID — the exact shape
		// that used to 404 because the client guessed `${uid}.ics`.
		const filename = `server-named-${Date.now()}.ics`;
		await createCalendarObject({
			calendar: { url: calendarUrl },
			filename,
			headers: { authorization: basic },
			iCalString: invite(uid, "Mismatch"),
		});

		const found = await fetchEvent(cfg, { calendarUrl, token, uid });
		expect(found).not.toBeNull();
		// Matched on the parsed UID, not the filename: the real href is the
		// server-chosen name, which bears no relation to the UID.
		expect(found?.url).toContain(filename);

		await deleteEvent(cfg, {
			token,
			url: found?.url ?? "",
			...(found?.etag ? { etag: found.etag } : {}),
		});
		expect(await fetchEvent(cfg, { calendarUrl, token, uid })).toBeNull();
	});

	// putEvent used to name the resource `${uid}.ics`, and our UIDs carried a
	// domain, so every created event landed under a name containing a raw `@`.
	//
	// What this proves is that the name *we* send survives a real server's
	// storage and comes back in the href unchanged. The guard that we never
	// derive the name from the payload is the hermetic `putEvent` test in
	// src/caldav/client.test.ts.
	test('stores a created event under a URL-safe name containing no "@" (regression)', async () => {
		const uid = `resource-name-${Date.now()}@mcp-it`;
		await putEvent(cfg, {
			calendarUrl,
			ical: invite(uid, "Resource name"),
			token,
		});

		const stored = await fetchEvent(cfg, { calendarUrl, token, uid });
		expect(stored).not.toBeNull();

		const href = stored?.url ?? "";
		const resourceName = href.slice(href.lastIndexOf("/") + 1);
		expect(resourceName).not.toContain("@");
		expect(resourceName).not.toContain("%40");
		// And it is unrelated to the UID, per RFC 4791 §5.3.2 / §11.
		expect(resourceName).not.toContain("resource-name-");
		expect(resourceName).toMatch(UUID_ICS_RE);

		await deleteEvent(cfg, {
			token,
			url: href,
			...(stored?.etag ? { etag: stored.etag } : {}),
		});
	});

	test("fetchEvents lists every stored event regardless of filename", async () => {
		const a = `multi-a-${Date.now()}@mcp-it`;
		const b = `multi-b-${Date.now()}@mcp-it`;
		await putEvent(cfg, { calendarUrl, ical: invite(a, "A"), token });
		await createCalendarObject({
			calendar: { url: calendarUrl },
			filename: `b-${Date.now()}.ics`,
			headers: { authorization: basic },
			iCalString: invite(b, "B"),
		});

		const data = (await fetchEvents(cfg, { calendarUrl, token }))
			.map((o) => o.data)
			.join("\n");
		expect(data).toContain(a);
		expect(data).toContain(b);

		for (const uid of [a, b]) {
			const obj = await fetchEvent(cfg, { calendarUrl, token, uid });
			await deleteEvent(cfg, {
				token,
				url: obj?.url ?? "",
				...(obj?.etag ? { etag: obj.etag } : {}),
			});
		}
	});

	// End-to-end through the actual MCP tools (discover → resolve → collection
	// query → parse/format) — the same "Collection query" path that 404s when
	// the live server is unhealthy. Drives the tools the agent calls, not just
	// the client functions.
	test("list_calendar_events tool returns seeded events with their UIDs", async () => {
		const uid = `tool-list-${Date.now()}@mcp-it`;
		await putEvent(cfg, {
			calendarUrl,
			ical: invite(uid, "Tool Listed"),
			token,
		});

		const result = await listCalendarEvents(makeListDeps(cfg), {
			args: { calendarUrl },
			token,
		});
		expect(result.isError).toBeUndefined();
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Tool Listed");
		expect(text).toContain(`uid: ${uid}`);

		const obj = await fetchEvent(cfg, { calendarUrl, token, uid });
		await deleteEvent(cfg, {
			token,
			url: obj?.url ?? "",
			...(obj?.etag ? { etag: obj.etag } : {}),
		});
	});

	// The read half of the attendee-edit fix: a stored event's attendees must
	// survive the PUT and come back through the list tool, so a caller can read
	// the current membership from the server instead of an external mirror. Unit
	// tests prove we parse attendees; this proves Stalwart stores and returns them.
	test("list_calendar_events surfaces the stored attendees so they read from Langmail", async () => {
		const uid = `attendees-${Date.now()}@mcp-it`;
		await putEvent(cfg, {
			calendarUrl,
			ical: buildInvite({
				attendees: [
					"adam@example.org",
					"luca@example.com",
					"traun@example.com",
				],
				end: new Date("2026-06-12T10:30:00Z"),
				organizer: me,
				start: new Date("2026-06-12T10:00:00Z"),
				title: "Attendee readback",
				uid,
			}),
			token,
		});

		const result = await listCalendarEvents(makeListDeps(cfg), {
			args: { calendarUrl },
			token,
		});
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("attendees:");
		expect(text).toContain("adam@example.org");
		expect(text).toContain("luca@example.com");
		expect(text).toContain("traun@example.com");

		const obj = await fetchEvent(cfg, { calendarUrl, token, uid });
		await deleteEvent(cfg, {
			token,
			url: obj?.url ?? "",
			...(obj?.etag ? { etag: obj.etag } : {}),
		});
	});

	test("listing a calendar with no events returns an empty result, not an error", async () => {
		// A dedicated, never-populated collection guarantees emptiness regardless
		// of test ordering — mirrors the reported repro (delete all → list → []).
		const emptyUrl = `${home}mcp-it-empty/`;
		const res = await fetch(emptyUrl, {
			headers: { authorization: basic },
			method: "MKCALENDAR",
		});
		if (res.status !== 201) {
			throw new Error(`MKCALENDAR ${emptyUrl} failed: ${res.status}`);
		}

		expect(await fetchEvents(cfg, { calendarUrl: emptyUrl, token })).toEqual(
			[]
		);

		const result = await listCalendarEvents(makeListDeps(cfg), {
			args: { calendarUrl: emptyUrl },
			token,
		});
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("No events found");
	});

	// MKCALENDAR path: the new collection lands under the principal's
	// calendar-home-set, carries the requested display name, and is immediately
	// discoverable by fetchCalendarList — i.e. usable by create_calendar_event.
	test("createCalendar makes a discoverable collection with the requested name", async () => {
		const name = `Marketing ${Date.now()}`;
		const url = await createCalendar(cfg, {
			color: "#FF6600",
			name,
			token,
		});
		expect(url).toContain(base);

		const calendars = await fetchCalendarList(cfg, token);
		const created = calendars.find(
			(c) => withTrailingSlash(c.url) === withTrailingSlash(url)
		);
		expect(created).toBeDefined();
		expect(created?.displayName).toBe(name);

		// Clean up the collection so repeated local runs don't accumulate calendars
		// (the event tests delete what they create; keep parity).
		await fetch(url, { headers: { authorization: basic }, method: "DELETE" });
	});

	test("delete_calendar_event tool removes an event addressed by UID (filename differs)", async () => {
		const uid = `tool-del-${Date.now()}@mcp-it`;
		await createCalendarObject({
			calendar: { url: calendarUrl },
			filename: `tool-del-named-${Date.now()}.ics`,
			headers: { authorization: basic },
			iCalString: invite(uid, "Tool Delete"),
		});

		const result = await deleteCalendarEvent(makeDeleteDeps(cfg), {
			args: { calendarUrl, uid },
			token,
		});
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("deleted");
		expect(await fetchEvent(cfg, { calendarUrl, token, uid })).toBeNull();
	});

	// The respond_to_event "CI moment": PUT an event whose ATTENDEE is our user
	// with PARTSTAT=NEEDS-ACTION, run the tool against the live server, and
	// assert the stored object now reads PARTSTAT=ACCEPTED. Everything is the
	// real client, discovery included: Stalwart reports the account's
	// calendar-user-address-set, which is how the tool knows which ATTENDEE is
	// the user.
	test("respond_to_event flips the stored PARTSTAT to ACCEPTED", async () => {
		const uid = `rsvp-${Date.now()}@mcp-it`;
		await putEvent(cfg, {
			calendarUrl,
			ical: buildInvite({
				attendees: [me],
				end: new Date("2026-06-12T10:30:00Z"),
				organizer: "organizer@example.com",
				start: new Date("2026-06-12T10:00:00Z"),
				title: "Invite to RSVP",
				uid,
			}),
			token,
		});

		const seeded = await fetchEvent(cfg, { calendarUrl, token, uid });
		expect(seeded?.data).toContain("PARTSTAT=NEEDS-ACTION");

		const result = await respondToEvent(makeRespondDeps(cfg), {
			args: { calendarUrl, response: "accept", uid },
			token,
		});
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("Invite to RSVP");

		const updated = await fetchEvent(cfg, { calendarUrl, token, uid });
		expect(updated?.data).toContain("PARTSTAT=ACCEPTED");
		expect(updated?.data).not.toContain("PARTSTAT=NEEDS-ACTION");

		await deleteEvent(cfg, {
			token,
			url: updated?.url ?? "",
			...(updated?.etag ? { etag: updated.etag } : {}),
		});
	});
});
