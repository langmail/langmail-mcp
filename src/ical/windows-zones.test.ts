import { describe, expect, test } from "vitest";

import { ianaTimeZone, WINDOWS_ZONES } from "./windows-zones.ts";

describe("ianaTimeZone", () => {
	test.each([
		["W. Europe Standard Time", "Europe/Berlin"],
		["Eastern Standard Time", "America/New_York"],
		["GMT Standard Time", "Europe/London"],
	])("maps the Windows name %s to %s", (windows, iana) => {
		expect(ianaTimeZone(windows)).toBe(iana);
	});

	// A table entry the runtime can't resolve would read events as Invalid Date.
	test("maps every Windows name to a zone the runtime knows", () => {
		for (const zone of Object.values(WINDOWS_ZONES)) {
			expect(
				() => new Intl.DateTimeFormat("en-US", { timeZone: zone })
			).not.toThrow();
		}
	});

	test("returns an IANA zone, or a name it does not know, unchanged", () => {
		expect(ianaTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
		expect(ianaTimeZone("UTC")).toBe("UTC");
		expect(ianaTimeZone("Example Standard Time")).toBe("Example Standard Time");
	});
});
