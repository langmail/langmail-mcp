// Reading tool results the way an agent does: from the text the tool
// returned. A suite that drives the server through an MCP client takes ids
// from here, not from a JMAP request of its own.

const HIT_ID_RE = /^ {3}id: (\S+)$/gmu;
const HIT_FROM_RE = /^ {3}from: (.*)$/gmu;
const HIT_DATE_RE = /^ {3}date: (.*)$/gmu;
const HIT_SUBJECT_RE = /^\d+\. (.*)$/gmu;
const REQUESTED_MARK = "  ← requested";

interface ToolCallResult {
	content?: unknown;
	isError?: boolean;
}

/** The text of a tool result: its text blocks, joined. */
export const toolText = (result: ToolCallResult): string =>
	(Array.isArray(result.content) ? result.content : [])
		.flatMap((block: { text?: unknown; type?: unknown }) =>
			block.type === "text" && typeof block.text === "string"
				? [block.text]
				: []
		)
		.join("\n");

/** One message of a `search_emails` or `get_thread` listing. */
export interface ListedMessage {
	date: string;
	from: string;
	id: string;
	/** `get_thread` marks the message it was asked about. */
	requested: boolean;
	subject: string;
}

const captures = (text: string, pattern: RegExp): string[] =>
	[...text.matchAll(pattern)].map((match) => match[1] as string);

/**
 * The messages a `search_emails` or `get_thread` result lists, in the order
 * listed. Throws when the listing does not have one id, sender and date per
 * numbered subject line, so a changed output format fails here and not in a
 * later assertion.
 */
export const listedMessages = (text: string): ListedMessage[] => {
	const subjects = captures(text, HIT_SUBJECT_RE);
	const ids = captures(text, HIT_ID_RE);
	const senders = captures(text, HIT_FROM_RE);
	const dates = captures(text, HIT_DATE_RE);
	if (
		ids.length !== subjects.length ||
		senders.length !== subjects.length ||
		dates.length !== subjects.length
	) {
		throw new Error(`cannot read the messages listed in:\n${text}`);
	}
	return subjects.map((subject, index) => ({
		date: dates[index] as string,
		from: senders[index] as string,
		id: ids[index] as string,
		requested: subject.endsWith(REQUESTED_MARK),
		subject: subject.endsWith(REQUESTED_MARK)
			? subject.slice(0, -REQUESTED_MARK.length)
			: subject,
	}));
};
