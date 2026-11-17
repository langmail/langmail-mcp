import { describe, expect, test } from "vitest";

import type { ParsedAlarm } from "../ical/index.ts";

import {
	describeAlarm,
	describeReminder,
	MAX_REMINDER_MINUTES,
} from "./alarm.ts";

// A stored VALARM as ical-parse hands it over: the TRIGGER value plus its raw
// parameter list. `lines` carries the untouched source, which this module never
// reads, so an empty list keeps each case to the fields under test.
const alarm = (trigger?: string, triggerParams?: string): ParsedAlarm => ({
	lines: [],
	...(trigger === undefined ? {} : { trigger }),
	...(triggerParams === undefined ? {} : { triggerParams }),
});

describe("MAX_REMINDER_MINUTES", () => {
	test("is four weeks of minutes", () => {
		expect(MAX_REMINDER_MINUTES).toBe(40_320);
	});
});

describe("describeReminder on a timed event", () => {
	test("names the largest whole unit", () => {
		expect(describeReminder(30, false)).toBe("30 minutes before");
		expect(describeReminder(60, false)).toBe("1 hour before");
		expect(describeReminder(120, false)).toBe("2 hours before");
		expect(describeReminder(1440, false)).toBe("1 day before");
		expect(describeReminder(2880, false)).toBe("2 days before");
		expect(describeReminder(1500, false)).toBe("25 hours before");
		expect(describeReminder(10_080, false)).toBe("1 week before");
		expect(describeReminder(20_160, false)).toBe("2 weeks before");
		expect(describeReminder(MAX_REMINDER_MINUTES, false)).toBe(
			"4 weeks before"
		);
	});

	test("singularises one of each unit", () => {
		expect(describeReminder(1, false)).toBe("1 minute before");
		expect(describeReminder(60, false)).toBe("1 hour before");
		expect(describeReminder(1440, false)).toBe("1 day before");
		expect(describeReminder(10_080, false)).toBe("1 week before");
	});

	// Only an exact multiple is promoted, so a span that straddles two units
	// stays in minutes rather than becoming "1 hour 30 minutes".
	test("keeps minutes when the span is not a whole number of larger units", () => {
		expect(describeReminder(59, false)).toBe("59 minutes before");
		expect(describeReminder(90, false)).toBe("90 minutes before");
		expect(describeReminder(1470, false)).toBe("1470 minutes before");
	});

	test("renders no offset at all as zero minutes", () => {
		expect(describeReminder(0, false)).toBe("0 minutes before");
	});
});

describe("describeReminder on an all-day event", () => {
	// An all-day event starts at 00:00, so an offset is read back as the clock
	// time the reminder fires rather than as a span before the start.
	test("converts the offset to the clock time it fires", () => {
		expect(describeReminder(900, true)).toBe("09:00 the day before");
		expect(describeReminder(540, true)).toBe("15:00 the day before");
		expect(describeReminder(30, true)).toBe("23:30 the day before");
	});

	test('says "on the day" when the reminder fires at the start', () => {
		expect(describeReminder(0, true)).toBe("00:00 on the day");
	});

	test("counts whole days back at midnight", () => {
		expect(describeReminder(1440, true)).toBe("00:00 the day before");
		expect(describeReminder(2880, true)).toBe("00:00 2 days before");
	});

	test("rounds a part-day offset up to the day it falls in", () => {
		expect(describeReminder(1980, true)).toBe("15:00 2 days before");
	});

	// Unlike the timed phrasing, the all-day phrasing always speaks in days: a
	// week out reads "7 days before", never "1 week before".
	test("speaks in days even for a whole number of weeks", () => {
		expect(describeReminder(10_080, true)).toBe("00:00 7 days before");
	});
});

describe("describeAlarm with a relative trigger", () => {
	test('reads a negative offset as "before start"', () => {
		expect(describeAlarm(alarm("-PT30M"))).toBe("30 minutes before start");
		expect(describeAlarm(alarm("-PT1H"))).toBe("1 hour before start");
		expect(describeAlarm(alarm("-P1W"))).toBe("1 week before start");
	});

	test('reads a positive offset as "after start"', () => {
		expect(describeAlarm(alarm("PT1H"))).toBe("1 hour after start");
		expect(describeAlarm(alarm("+PT30M"))).toBe("30 minutes after start");
	});

	test('says "at start" for a zero offset', () => {
		expect(describeAlarm(alarm("PT0S"))).toBe("at start");
	});

	test("sums the components of a compound duration", () => {
		expect(describeAlarm(alarm("-P1DT2H"))).toBe("26 hours before start");
	});

	test("matches a duration case-insensitively", () => {
		expect(describeAlarm(alarm("-pt30m"))).toBe("30 minutes before start");
	});
});

describe("describeAlarm anchoring", () => {
	test("anchors to the end when RELATED=END is set", () => {
		expect(describeAlarm(alarm("PT0S", ";RELATED=END"))).toBe("at end");
		expect(describeAlarm(alarm("PT1H", ";RELATED=END"))).toBe(
			"1 hour after end"
		);
		expect(describeAlarm(alarm("-PT30M", ";RELATED=END"))).toBe(
			"30 minutes before end"
		);
	});

	test("matches RELATED=END case-insensitively and without a leading separator", () => {
		expect(describeAlarm(alarm("PT0S", ";related=end"))).toBe("at end");
		expect(describeAlarm(alarm("PT0S", "RELATED=END"))).toBe("at end");
	});

	test("anchors to the start for any other parameter list", () => {
		expect(describeAlarm(alarm("PT0S", ";VALUE=DATE-TIME"))).toBe("at start");
		expect(describeAlarm(alarm("-PT10M", ";RELATED=START"))).toBe(
			"10 minutes before start"
		);
	});
});

describe("describeAlarm sub-minute precision", () => {
	// A foreign client can store an offset that is not a whole number of
	// minutes; the seconds are kept rather than rounded away.
	test("keeps the seconds of a part-minute offset", () => {
		expect(describeAlarm(alarm("-PT90S"))).toBe(
			"1 minute 30 seconds before start"
		);
		expect(describeAlarm(alarm("-PT1H1M30S"))).toBe(
			"61 minutes 30 seconds before start"
		);
	});

	test('reports a sub-minute offset in seconds rather than as "at start"', () => {
		expect(describeAlarm(alarm("-PT29S"))).toBe("29 seconds before start");
		expect(describeAlarm(alarm("-PT1S"))).toBe("1 second before start");
	});
});

describe("describeAlarm with an absolute trigger", () => {
	test("renders a date-time trigger as an ISO instant", () => {
		expect(describeAlarm(alarm("20261002T090000Z"))).toBe(
			"at 2026-10-02T09:00:00Z"
		);
	});

	test("renders a date-only trigger as a plain date", () => {
		expect(describeAlarm(alarm("20261002"))).toBe("at 2026-10-02");
	});

	test("passes an unparseable trigger through verbatim", () => {
		expect(describeAlarm(alarm("not-a-duration"))).toBe("at not-a-duration");
	});
});

describe("describeAlarm with no usable trigger", () => {
	test("reports a missing trigger", () => {
		expect(describeAlarm(alarm())).toBe("unknown trigger");
	});

	test("reports an empty trigger", () => {
		expect(describeAlarm(alarm(""))).toBe("unknown trigger");
	});
});

describe("describeAlarm on an all-day event", () => {
	test("converts a whole-minute offset before the start to a clock time", () => {
		expect(describeAlarm(alarm("-P1D"), true)).toBe("00:00 the day before");
		expect(describeAlarm(alarm("-PT15H"), true)).toBe("09:00 the day before");
	});

	test('converts a zero offset to the midnight start rather than "at start"', () => {
		expect(describeAlarm(alarm("PT0S"), true)).toBe("00:00 on the day");
	});

	// The clock-time phrasing only covers a whole-minute offset anchored before
	// the start; anything else keeps the timed phrasing.
	test("keeps the timed phrasing for a part-minute offset", () => {
		expect(describeAlarm(alarm("-PT90S"), true)).toBe(
			"1 minute 30 seconds before start"
		);
	});

	test("keeps the timed phrasing for an offset after the start", () => {
		expect(describeAlarm(alarm("PT1H"), true)).toBe("1 hour after start");
	});

	test("keeps the timed phrasing for an offset anchored to the end", () => {
		expect(describeAlarm(alarm("-PT30M", ";RELATED=END"), true)).toBe(
			"30 minutes before end"
		);
	});

	test("treats the event as timed when allDay is omitted", () => {
		expect(describeAlarm(alarm("-P1D"))).toBe("1 day before start");
	});
});
