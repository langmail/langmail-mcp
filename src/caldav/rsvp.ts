// Pure iCalendar mutation for RSVP: set the authenticated user's own
// ATTENDEE PARTSTAT on a stored VEVENT, leaving every other byte untouched
// so the PUT back to CalDAV is a minimal diff.
//
// This is the meat behind respond_to_event. Keeping it pure (string in,
// string out) makes the edge cases — line folding, case-insensitive
// matching, insert-vs-replace — unit-testable without a live server.

export type Partstat = "ACCEPTED" | "DECLINED" | "TENTATIVE";

export type SetPartstatResult =
	| { ok: true; ical: string }
	| { ok: false; reason: "not-an-attendee" };

// Splits on a line break (CRLF, bare CR, or LF) while capturing the break,
// so we can rejoin every unedited line byte-for-byte.
const NL_SPLIT_RE = /(\r\n|\r|\n)/u;
// RFC 5545 §3.1: a folded continuation line begins with a single space/tab.
const CONT_RE = /^[ \t]/u;
const MAILTO_RE = /^mailto:/iu;
// A PARTSTAT parameter on a content line's parameter list. The value runs to
// the next `;` (further param) or `:` (start of the property value).
const PARTSTAT_PARAM_RE = /;PARTSTAT=[^;:]*/iu;

// One physical line plus the exact line break that followed it (empty for the
// final line). Preserving the break verbatim keeps non-edited lines unchanged.
interface PhysicalLine {
	sep: string;
	text: string;
}

const toPhysicalLines = (ical: string): PhysicalLine[] => {
	// split() with a capturing group yields [text, sep, text, sep, ..., text].
	const tokens = ical.split(NL_SPLIT_RE);
	const lines: PhysicalLine[] = [];
	for (let i = 0; i < tokens.length; i += 2) {
		lines.push({ sep: tokens[i + 1] ?? "", text: tokens[i] ?? "" });
	}
	return lines;
};

// Inclusive index range of the physical lines making up one logical (unfolded)
// content line: a starter line plus any folded continuations.
interface LogicalLine {
	end: number;
	start: number;
}

const groupLogicalLines = (lines: PhysicalLine[]): LogicalLine[] => {
	const groups: LogicalLine[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const last = groups.at(-1);
		if (last && CONT_RE.test(lines[i]?.text ?? "")) {
			last.end = i;
		} else {
			groups.push({ end: i, start: i });
		}
	}
	return groups;
};

// Reconstructs the logical line, dropping the single leading whitespace each
// continuation contributed (the inverse of RFC 5545 folding).
const unfold = (lines: PhysicalLine[], group: LogicalLine): string => {
	let s = lines[group.start]?.text ?? "";
	for (let i = group.start + 1; i <= group.end; i += 1) {
		s += (lines[i]?.text ?? "").slice(1);
	}
	return s;
};

// True when `logical` is the ATTENDEE line for `email`, matching the `mailto:`
// scheme and the address case-insensitively (RFC 5545 calendar-user-addresses
// are case-insensitive; clients vary on casing).
const isAttendeeFor = (logical: string, email: string): boolean => {
	// First-colon split to separate NAME+params from the value. A param value
	// quoting a literal ':' (e.g. CN="Org:Unit") would misplace this boundary
	// and the line would silently miss — the same happy-path caveat ical-parse.ts
	// documents, and out of scope for this workshop tool.
	const colon = logical.indexOf(":");
	if (colon === -1) {
		return false;
	}
	// The property name ends at the first `;` (params) or the value colon.
	const name = (logical.slice(0, colon).split(";")[0] ?? "")
		.trim()
		.toUpperCase();
	if (name !== "ATTENDEE") {
		return false;
	}
	const value = logical.slice(colon + 1).trim();
	if (!MAILTO_RE.test(value)) {
		return false;
	}
	return value.replace(MAILTO_RE, "").toLowerCase() === email.toLowerCase();
};

// Replaces an existing PARTSTAT param on the matched line, or inserts one at
// the end of the parameter list when absent. The property value (`:mailto:…`)
// is preserved exactly; only the parameter section changes.
const withPartstat = (logical: string, partstat: Partstat): string => {
	const colon = logical.indexOf(":");
	const head = logical.slice(0, colon);
	const value = logical.slice(colon);
	if (PARTSTAT_PARAM_RE.test(head)) {
		return head.replace(PARTSTAT_PARAM_RE, `;PARTSTAT=${partstat}`) + value;
	}
	return `${head};PARTSTAT=${partstat}${value}`;
};

export const setAttendeePartstat = (
	ical: string,
	attendeeEmail: string,
	partstat: Partstat
): SetPartstatResult => {
	const lines = toPhysicalLines(ical);
	const groups = groupLogicalLines(lines);

	const match = groups.find((g) =>
		isAttendeeFor(unfold(lines, g), attendeeEmail)
	);
	if (!match) {
		return { ok: false, reason: "not-an-attendee" };
	}

	// Re-emit the matched line unfolded. Re-folding is intentionally skipped:
	// both Radicale and Stalwart accept over-length lines and there is no fold
	// helper on the write path — see the design doc.
	const edited = withPartstat(unfold(lines, match), partstat);

	const out: string[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		if (i === match.start) {
			out.push(edited, lines[match.end]?.sep ?? "");
			i = match.end;
			continue;
		}
		const line = lines[i];
		out.push(line?.text ?? "", line?.sep ?? "");
	}
	return { ical: out.join(""), ok: true };
};
