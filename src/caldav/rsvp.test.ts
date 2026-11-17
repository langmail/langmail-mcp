import { describe, expect, test } from "vitest";

import { buildInvite } from "./ical.ts";
import { setAttendeePartstat } from "./rsvp.ts";

// A minimal VEVENT with one ATTENDEE line, built by hand so each test controls
// the exact parameter list / folding under test. CRLF line breaks like a real
// server response.
const vevent = (attendeeLines: string[]): string =>
	[
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"BEGIN:VEVENT",
		"UID:evt-1@example.com",
		"SUMMARY:Weekly sync",
		"SEQUENCE:3",
		...attendeeLines,
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n");

describe("setAttendeePartstat", () => {
	test("replaces an existing PARTSTAT value", () => {
		const ical = vevent([
			"ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@example.com",
		]);
		const result = setAttendeePartstat(ical, "me@example.com", "ACCEPTED");
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.ical).toContain(
			"ATTENDEE;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:me@example.com"
		);
		expect(result.ical).not.toContain("NEEDS-ACTION");
	});

	test("inserts PARTSTAT when the ATTENDEE line has none", () => {
		const ical = vevent([
			"ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:me@example.com",
		]);
		const result = setAttendeePartstat(ical, "me@example.com", "DECLINED");
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.ical).toContain(
			"ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=DECLINED:mailto:me@example.com"
		);
	});

	test("matches the mailto scheme and address case-insensitively", () => {
		const ical = vevent([
			"ATTENDEE;PARTSTAT=NEEDS-ACTION:MAILTO:Me@Example.COM",
		]);
		const result = setAttendeePartstat(ical, "me@example.com", "TENTATIVE");
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		// The original value casing is preserved verbatim; only PARTSTAT changes.
		expect(result.ical).toContain(
			"ATTENDEE;PARTSTAT=TENTATIVE:MAILTO:Me@Example.COM"
		);
	});

	test("handles a folded ATTENDEE line (real ical-generator output)", () => {
		// buildInvite folds the ATTENDEE line mid-address at 75 octets.
		const ical = buildInvite({
			attendees: ["attendee-with-a-long-address@example.com"],
			end: new Date("2026-06-12T10:30:00Z"),
			organizer: "org@example.com",
			start: new Date("2026-06-12T10:00:00Z"),
			title: "Weekly sync",
			uid: "evt-1@example.com",
		});
		expect(ical.includes("\r\n ")).toBe(true); // sanity: it really is folded

		const result = setAttendeePartstat(
			ical,
			"attendee-with-a-long-address@example.com",
			"ACCEPTED"
		);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		// The edited line is re-emitted unfolded, so PARTSTAT and the full address
		// reassemble onto one logical line — assert them together to catch a
		// regression that splits the output.
		expect(result.ical).toContain(
			"PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:attendee-with-a-long-address@example.com"
		);
		expect(result.ical).not.toContain("NEEDS-ACTION");
	});

	test("changes only the matching attendee; others are untouched", () => {
		const ical = vevent([
			"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:other@example.com",
			"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com",
			"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:third@example.com",
		]);
		const result = setAttendeePartstat(ical, "me@example.com", "ACCEPTED");
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.ical).toContain(
			"ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com"
		);
		expect(result.ical).toContain(
			"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:other@example.com"
		);
		expect(result.ical).toContain(
			"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:third@example.com"
		);
	});

	test("leaves every other line — including SEQUENCE — byte-for-byte unchanged", () => {
		const ical = vevent([
			"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com",
		]);
		const result = setAttendeePartstat(ical, "me@example.com", "ACCEPTED");
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		// The only difference from the input is the PARTSTAT value on our line.
		expect(result.ical).toBe(ical.replace("NEEDS-ACTION", "ACCEPTED"));
		expect(result.ical).toContain("\r\nSEQUENCE:3\r\n");
	});

	test("returns not-an-attendee when no ATTENDEE line matches", () => {
		const ical = vevent([
			"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:someone-else@example.com",
		]);
		const result = setAttendeePartstat(ical, "me@example.com", "ACCEPTED");
		expect(result).toEqual({ ok: false, reason: "not-an-attendee" });
	});
});
