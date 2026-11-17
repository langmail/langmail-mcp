import { describe, expect, test } from "vitest";

import type { CreateCalendarParams } from "../caldav/client.ts";
import { createCalendar, createCalendarInput } from "./create-calendar.ts";

const makeDeps = (
	captured: CreateCalendarParams[] = [],
	url = "https://m/dav/cal/u/abc/"
) => ({
	createCalendar: (p: CreateCalendarParams) => {
		captured.push(p);
		return Promise.resolve(url);
	},
});

describe("createCalendarInput schema", () => {
	test("requires a name", () => {
		expect(createCalendarInput.safeParse({}).success).toBe(false);
	});

	test("rejects an empty name", () => {
		expect(createCalendarInput.safeParse({ name: "" }).success).toBe(false);
	});

	test("accepts a name with no color", () => {
		expect(createCalendarInput.safeParse({ name: "Marketing" }).success).toBe(
			true
		);
	});

	test("accepts a valid hex color", () => {
		expect(
			createCalendarInput.safeParse({ color: "#FF6600", name: "Marketing" })
				.success
		).toBe(true);
		expect(
			createCalendarInput.safeParse({ color: "#FF6600FF", name: "Marketing" })
				.success
		).toBe(true);
	});

	test("rejects a malformed color", () => {
		expect(
			createCalendarInput.safeParse({ color: "orange", name: "Marketing" })
				.success
		).toBe(false);
		expect(
			createCalendarInput.safeParse({ color: "#FFF", name: "Marketing" })
				.success
		).toBe(false);
	});
});

describe("createCalendar", () => {
	test("creates the calendar and reports its URL", async () => {
		const captured: CreateCalendarParams[] = [];
		const result = await createCalendar(makeDeps(captured), {
			args: { name: "Marketing" },
			token: "tok",
		});

		expect(captured).toHaveLength(1);
		expect(captured[0]?.name).toBe("Marketing");
		expect(captured[0]?.token).toBe("tok");
		// No color passed through when none was requested.
		expect(captured[0]?.color).toBeUndefined();

		const txt = result.content[0]?.text ?? "";
		expect(result.isError).toBeUndefined();
		expect(txt).toContain("Marketing");
		expect(txt).toContain("calendarUrl: https://m/dav/cal/u/abc/");
	});

	test("threads an explicit color through to the deps", async () => {
		const captured: CreateCalendarParams[] = [];
		await createCalendar(makeDeps(captured), {
			args: { color: "#FF6600", name: "Marketing" },
			token: "tok",
		});

		expect(captured[0]?.color).toBe("#FF6600");
	});
});
