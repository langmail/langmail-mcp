import { describe, expect, test } from "vitest";

import type { CalendarSummary } from "../caldav/types.ts";
import { type ListCalendarsDeps, listCalendars } from "./list-calendars.ts";

const deps = (calendars: CalendarSummary[]): ListCalendarsDeps => ({
	listCalendars: () => Promise.resolve(calendars),
});

describe("listCalendars", () => {
	test("formats each calendar with its display name and url", async () => {
		const result = await listCalendars(
			deps([
				{ displayName: "Work", url: "https://m/dav/cal/u/default/" },
				{ displayName: "Personal", url: "https://m/dav/cal/u/personal/" },
			]),
			{ token: "tok" }
		);
		const txt = result.content[0]?.text ?? "";
		expect(txt).toContain("2 calendar(s)");
		expect(txt).toContain("Work");
		expect(txt).toContain("https://m/dav/cal/u/default/");
		expect(txt).toContain("Personal");
	});

	test("shows a calendar color when the server has one", async () => {
		const result = await listCalendars(
			deps([
				{
					color: "#FF6600",
					displayName: "Work",
					url: "https://m/dav/cal/u/default/",
				},
			]),
			{ token: "tok" }
		);
		expect(result.content[0]?.text).toContain("color: #FF6600");
	});

	test("labels an unnamed calendar", async () => {
		const result = await listCalendars(
			deps([{ displayName: "", url: "https://m/dav/cal/u/x/" }]),
			{ token: "tok" }
		);
		expect(result.content[0]?.text).toContain("(unnamed)");
	});

	test("reports 'no calendars' on an empty account", async () => {
		const result = await listCalendars(deps([]), {
			token: "tok",
		});
		expect((result.content[0]?.text ?? "").toLowerCase()).toContain(
			"no calendars"
		);
	});

	// The hosted tool adds a sharing line to every calendar ("shared with: …",
	// "not shared", or "sharing: unknown" without a share store). This server
	// has no calendar sharing, so the entry ends after the URL or the color.
	test("says nothing about sharing", async () => {
		const result = await listCalendars(
			deps([
				{
					color: "#FF6600",
					displayName: "Personal",
					url: "https://mail.example.com/dav/cal/ana%40example.com/personal/",
				},
				{
					displayName: "Family",
					url: "https://mail.example.com/dav/cal/ana%40example.com/family/",
				},
			]),
			{ token: "tok" }
		);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toBe(
			"2 calendar(s):\n\n" +
				"1. Personal\n   url: https://mail.example.com/dav/cal/ana%40example.com/personal/\n   color: #FF6600\n\n" +
				"2. Family\n   url: https://mail.example.com/dav/cal/ana%40example.com/family/"
		);
	});

	test("passes the credential to the calendar listing unchanged", async () => {
		const seen: string[] = [];
		await listCalendars(
			{
				listCalendars: (token) => {
					seen.push(token);
					return Promise.resolve([]);
				},
			},
			{ token: "Basic dXNlcjpwYXNz" }
		);
		expect(seen).toEqual(["Basic dXNlcjpwYXNz"]);
	});
});
