import { describe, expect, test } from "vitest";

import {
	observationsFromEmail,
	observationsFromEvent,
} from "./observations.ts";

const SELF = new Set(["me@example.com", "me.linked@gmail.com"]);

describe("observationsFromEmail", () => {
	test("grades an outgoing mail: To confirmed, CC weak, self excluded", () => {
		const { observations, relays } = observationsFromEmail(
			{
				cc: [{ email: "copied@corp.example", name: "Copied Person" }],
				from: [{ email: "me@example.com", name: "Me" }],
				id: "m1",
				receivedAt: "2026-07-20T12:00:00Z",
				to: [{ email: "Robin@northwind.example", name: "Robin Fairweather" }],
			},
			{ selfAddresses: SELF }
		);
		expect(relays).toEqual([]);
		expect(observations).toEqual([
			{
				address: "robin@northwind.example",
				channel: "email",
				confidence: "confirmed",
				date: "2026-07-20T12:00:00Z",
				direction: "outgoing",
				name: "Robin Fairweather",
				recordId: "m1",
			},
			{
				address: "copied@corp.example",
				channel: "email",
				confidence: "weak",
				date: "2026-07-20T12:00:00Z",
				direction: "outgoing",
				name: "Copied Person",
				recordId: "m1",
			},
		]);
	});

	test("detects outgoing via the Sent mailbox and never collects the From alias as a contact", () => {
		const { observations } = observationsFromEmail(
			{
				from: [{ email: "aliased@elsewhere.example" }],
				id: "m2",
				mailboxIds: { "mb-sent": true },
				receivedAt: "2026-07-20T12:00:00Z",
				to: [{ email: "robin@northwind.example" }],
			},
			{ selfAddresses: SELF, sentMailboxId: "mb-sent" }
		);
		// The From of sent mail is the user's own (possibly unknown) alias —
		// collecting it would make the user their own most active contact.
		expect(
			observations.map((o) => [o.address, o.confidence, o.direction])
		).toEqual([["robin@northwind.example", "confirmed", "outgoing"]]);
	});

	test("detects outgoing via a linked Gmail alias sender", () => {
		const { observations } = observationsFromEmail(
			{
				from: [{ email: "Me.Linked@gmail.com" }],
				id: "m3",
				receivedAt: "2026-07-20T12:00:00Z",
				to: [{ email: "robin@northwind.example" }],
			},
			{ selfAddresses: SELF }
		);
		expect(observations).toHaveLength(1);
		expect(observations[0]?.confidence).toBe("confirmed");
		expect(observations[0]?.direction).toBe("outgoing");
	});

	test("grades an incoming mail: From and To strong, CC weak", () => {
		const { observations } = observationsFromEmail(
			{
				cc: [{ email: "cc@corp.example" }],
				from: [{ email: "robin@northwind.example", name: "Robin" }],
				id: "m4",
				receivedAt: "2026-07-20T12:00:00Z",
				to: [
					{ email: "me@example.com" },
					{ email: "other@corp.example", name: "Other Person" },
				],
			},
			{ selfAddresses: SELF }
		);
		expect(
			observations.map((o) => [o.address, o.confidence, o.direction])
		).toEqual([
			["robin@northwind.example", "strong", "incoming"],
			["other@corp.example", "strong", "incoming"],
			["cc@corp.example", "weak", "incoming"],
		]);
	});

	test("never collects a plus-addressed form of the user’s own address", () => {
		const { observations } = observationsFromEmail(
			{
				from: [{ email: "robin@northwind.example" }],
				id: "m-plus",
				receivedAt: "2026-07-20T12:00:00Z",
				to: [{ email: "me+newsletters@example.com" }],
			},
			{ selfAddresses: SELF }
		);
		expect(observations.map((o) => o.address)).toEqual([
			"robin@northwind.example",
		]);
	});

	test("routes relay senders into relays instead of observations", () => {
		const { observations, relays } = observationsFromEmail(
			{
				from: [
					{ email: "messaging-digest-noreply@linkedin.com", name: "LinkedIn" },
				],
				id: "m5",
				receivedAt: "2026-07-20T12:00:00Z",
				to: [{ email: "me@example.com" }],
			},
			{ selfAddresses: SELF }
		);
		expect(observations).toEqual([]);
		expect(relays).toEqual([
			{ address: "messaging-digest-noreply@linkedin.com", recordId: "m5" },
		]);
	});

	test("drops a display name that is just the address again", () => {
		const { observations } = observationsFromEmail(
			{
				from: [
					{ email: "robin@northwind.example", name: "Robin@NorthWind.example" },
				],
				id: "m6",
				receivedAt: "2026-07-20T12:00:00Z",
			},
			{ selfAddresses: SELF }
		);
		expect(observations[0]?.name).toBeUndefined();
	});

	test("returns nothing for a record without a receivedAt", () => {
		const out = observationsFromEmail(
			{ from: [{ email: "a@b.example" }], id: "m7" },
			{ selfAddresses: SELF }
		);
		expect(out.observations).toEqual([]);
	});
});

describe("observationsFromEvent", () => {
	const robinAttendee = {
		email: "Robin@northwind.example",
		name: "Robin Fairweather",
		status: "NEEDS-ACTION",
	};

	test("a scheduling action yields confirmed attendees (the Robin case)", () => {
		const { observations } = observationsFromEvent(
			{
				attendees: [
					robinAttendee,
					{ email: "me@example.com", status: "ACCEPTED" },
				],
				organizer: "me@example.com",
				start: "2026-07-28T12:00:00Z",
				uid: "evt-lunch@example.com",
			},
			{ kind: "action", selfAddresses: SELF }
		);
		expect(observations).toEqual([
			{
				address: "robin@northwind.example",
				channel: "calendar",
				confidence: "confirmed",
				date: "2026-07-28T12:00:00Z",
				direction: "outgoing",
				name: "Robin Fairweather",
				recordId: "evt-lunch@example.com",
			},
		]);
	});

	test("an observed event without self acceptance grades strong", () => {
		const { observations } = observationsFromEvent(
			{
				attendees: [
					robinAttendee,
					{ email: "me@example.com", status: "NEEDS-ACTION" },
				],
				organizer: "host@corp.example",
				start: "2026-07-01T09:00:00Z",
				uid: "evt-observed",
			},
			{ kind: "observed", selfAddresses: SELF }
		);
		expect(
			observations.map((o) => [o.address, o.confidence, o.direction])
		).toEqual([
			["robin@northwind.example", "strong", "incoming"],
			["host@corp.example", "strong", "incoming"],
		]);
	});

	test("an observed event the user accepted grades confirmed", () => {
		const { observations } = observationsFromEvent(
			{
				attendees: [
					robinAttendee,
					{ email: "me@example.com", status: "accepted" },
				],
				organizer: "robin@northwind.example",
				start: "2026-06-30T09:00:00Z",
				uid: "evt-accepted",
			},
			{ kind: "observed", selfAddresses: SELF }
		);
		expect(observations).toEqual([
			{
				address: "robin@northwind.example",
				channel: "calendar",
				confidence: "confirmed",
				date: "2026-06-30T09:00:00Z",
				direction: "incoming",
				name: "Robin Fairweather",
				recordId: "evt-accepted",
			},
		]);
	});

	test("attendees of a large event grade weak, the organizer keeps its grade", () => {
		const attendees = Array.from({ length: 10 }, (_, i) => ({
			email: `p${i}@workshop.example`,
		}));
		const { observations } = observationsFromEvent(
			{
				attendees,
				organizer: "host@workshop.example",
				start: "2026-07-01T09:00:00Z",
				uid: "evt-large",
			},
			{ kind: "action", selfAddresses: SELF }
		);
		expect(
			observations.find((o) => o.address === "host@workshop.example")
				?.confidence
		).toBe("confirmed");
		for (const attendee of observations.filter(
			(o) => o.address !== "host@workshop.example"
		)) {
			expect(attendee.confidence).toBe("weak");
		}
	});
});
