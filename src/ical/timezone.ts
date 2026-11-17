// Wall-clock time helpers the VEVENT parser needs. Only the pure time
// arithmetic lives here — the zod input schemas that validate tool
// arguments (timeZoneSchema, dateTimeWithOptionalOffsetSchema, …) stay in
// services/mcp, which owns request validation, and re-export from here so
// there is a single implementation.

import { TZDate } from "@date-fns/tz";

import { ianaTimeZone } from "./windows-zones.ts";

// Exported so services/mcp's eventTimeSchema admits exactly what this reads.
export const DATE_TIME_RE =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|[+-]\d{2}:\d{2})?$/iu;

// Reads the clock digits of `value` as wall-clock time *in* `timeZone`,
// ignoring any offset the string carries. A stored RECURRENCE-ID or DTSTART
// with a TZID means "10:00 in Europe/Berlin", not "10:00 UTC", so resolving
// it needs the zone rather than Date's local-time default. A Windows zone name
// (`W. Europe Standard Time`) reads as its IANA zone.
export const parseWallClockInZone = (value: string, timeZone: string): Date => {
	const match = DATE_TIME_RE.exec(value);
	if (!match) {
		throw new Error(`invalid date-time: ${value}`);
	}
	const [, year, month, day, hour, minute, second, millis = "0"] = match;
	return TZDate.tz(
		ianaTimeZone(timeZone),
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second),
		Number(millis.padEnd(3, "0"))
	);
};
