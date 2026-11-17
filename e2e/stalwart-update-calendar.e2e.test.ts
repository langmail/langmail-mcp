// E2E for update_calendar against a REAL Stalwart. The unit tests prove the
// tool picks the right calendar and the client builds a PROPPATCH; this proves
// Stalwart accepts that PROPPATCH and hands the new name and color back on the
// next discovery — the round trip an agent relies on when it renames a
// calendar and then addresses it by the new name.
//
// Skips unless STALWART_ADMIN_URL is set; see e2e/README.md.

import { afterAll, beforeAll, expect, test } from "vitest";

import {
	type CalDavConfig,
	createCalendar,
	fetchCalendarList,
} from "../src/caldav/client.ts";
import { makeLiveDeps, updateCalendar } from "../src/tools/update-calendar.ts";
import { destroyCreatedAccounts } from "./support/admin.ts";
import { provisionPrincipal } from "./support/caldav.ts";
import { live } from "./support/env.ts";

live("update_calendar against live Stalwart — PROPPATCH round trip", () => {
	let cfg: CalDavConfig;
	// The account's credential: what the tool and the client take as `token`.
	let token: string;
	let defaultUrl: string;

	beforeAll(async () => {
		const principal = await provisionPrincipal("update-calendar");
		({ cfg, defaultUrl, token } = principal);
	});

	// Throwaway principal; destroying it also drops its calendar data.
	afterAll(destroyCreatedAccounts);

	test("renames and recolors the default calendar picked by its current name", async () => {
		const before = (await fetchCalendarList(cfg, token)).find(
			(c) => c.url === defaultUrl
		);
		expect(before?.displayName).toBeTruthy();

		const result = await updateCalendar(makeLiveDeps(cfg), {
			args: {
				calendar: before?.displayName ?? "",
				color: "#2E6FD8",
				name: "Business",
			},
			token,
		});
		expect(result.isError).toBeUndefined();

		const after = (await fetchCalendarList(cfg, token)).find(
			(c) => c.url === defaultUrl
		);
		expect(after?.displayName).toBe("Business");
		expect(after?.color?.toUpperCase().startsWith("#2E6FD8")).toBe(true);
	});

	test("recolors a calendar picked by URL and leaves its name alone", async () => {
		const url = await createCalendar(cfg, {
			name: "Side project",
			token,
		});

		const result = await updateCalendar(makeLiveDeps(cfg), {
			args: { calendar: url, color: "#7FA6C9" },
			token,
		});
		expect(result.isError).toBeUndefined();

		const after = (await fetchCalendarList(cfg, token)).find(
			(c) => c.url === url
		);
		expect(after?.displayName).toBe("Side project");
		expect(after?.color?.toUpperCase().startsWith("#7FA6C9")).toBe(true);
	});
});
