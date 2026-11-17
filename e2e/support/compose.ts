// What the composing suites share: reading a mailbox the way the far end of
// a send sees it, and calling the built server's tools through an MCP client.

import type { Client } from "@modelcontextprotocol/client";
import {
	blobDownload,
	type EmailComposeRecord,
	emailComposeGet,
	emailQuery,
} from "../../src/jmap/index.ts";
import type { MailSession } from "./mail.ts";
import { pollUntil } from "./wait.ts";

// Local delivery is asynchronous: a submission returns once the message is
// queued, not once it has landed. Other suites load the same server, so the
// budget is generous; a healthy delivery takes well under a second.
const DELIVERY_BUDGET_MS = 45_000;
const DELIVERY_INTERVAL_MS = 150;
const BODY_BUDGET_BYTES = 100_000;
const QUERY_LIMIT = 100;

/** The ids a tool result names, pulled out of its text as a client would. */
export const DRAFT_ID_RE = /draftId: (\S+)/u;
export const MESSAGE_ID_RE = /messageId: (\S+)/u;

const ctx = (
	session: MailSession
): { accountId: string; apiUrl: string; authorization: string } => ({
	accountId: session.accountId,
	apiUrl: session.apiUrl,
	authorization: session.authorization,
});

/** Ids of the messages in one mailbox of the session's account. */
export const idsIn = (
	session: MailSession,
	mailbox: string
): Promise<string[]> =>
	emailQuery({
		...ctx(session),
		filters: { mailboxId: mailbox },
		limit: QUERY_LIMIT,
	});

/** One message as the composing tools read it, with its body values. */
export const composeRecord = (
	session: MailSession,
	id: string
): Promise<EmailComposeRecord | null> =>
	emailComposeGet({
		...ctx(session),
		bodyValues: "body",
		id,
		maxBodyValueBytes: BODY_BUDGET_BYTES,
	});

/** Every body value of a message, joined: its text and html parts. */
export const bodyOf = (record: EmailComposeRecord | null): string =>
	Object.values(record?.bodyValues ?? {})
		.map((value) => value.value)
		.join("\n");

/**
 * Waits until messages that were not in `mailbox` before have arrived there
 * and returns their ids. Throws when none arrives within the budget, so a
 * suite fails on the delivery that never happened and not on timing.
 */
export const awaitDelivery = (
	session: MailSession,
	mailbox: string,
	before: string[]
): Promise<string[]> =>
	pollUntil(
		async () =>
			(await idsIn(session, mailbox)).filter((id) => !before.includes(id)),
		(fresh) => fresh.length > 0,
		{
			intervalMs: DELIVERY_INTERVAL_MS,
			timeoutMs: DELIVERY_BUDGET_MS,
			waitingFor: `a delivery to ${session.username}`,
		}
	);

/**
 * The messages in `mailbox` that carry this subject, read now. One request
 * at a time: Stalwart refuses an account's fifth concurrent request.
 */
export const withSubject = async (
	session: MailSession,
	mailbox: string,
	subject: string
): Promise<EmailComposeRecord[]> => {
	const found: EmailComposeRecord[] = [];
	for (const id of await idsIn(session, mailbox)) {
		const record = await composeRecord(session, id);
		if (record?.subject === subject) {
			found.push(record);
		}
	}
	return found;
};

/**
 * Waits for the message with this subject to arrive in `mailbox` and returns
 * every message there that carries it: one, unless it was delivered twice.
 */
export const awaitSubject = async (
	session: MailSession,
	mailbox: string,
	subject: string
): Promise<EmailComposeRecord[]> =>
	await pollUntil(
		() => withSubject(session, mailbox, subject),
		(found) => found.length > 0,
		{
			intervalMs: DELIVERY_INTERVAL_MS,
			timeoutMs: DELIVERY_BUDGET_MS,
			waitingFor: `"${subject}" to arrive for ${session.username}`,
		}
	);

/** The bytes Stalwart holds for a blob of the session's account. */
export const blobBytes = async (
	session: MailSession,
	blobId: string,
	name: string,
	type: string
): Promise<Uint8Array> => {
	const res = await blobDownload({
		accountId: session.accountId,
		authorization: session.authorization,
		blobId,
		downloadUrl: session.downloadUrl,
		name,
		type,
	});
	return new Uint8Array(await res.arrayBuffer());
};

export interface AttachedFile {
	bytes: Uint8Array;
	name: string;
	size: number;
	type: string;
}

/**
 * The attachment parts of a message, each with its blob fetched. Every "the
 * file survived" assertion goes through the bytes: a part with the right
 * name and size can still hold the wrong content.
 */
export const attachmentsOf = async (
	session: MailSession,
	emailId: string
): Promise<AttachedFile[]> => {
	const record = await composeRecord(session, emailId);
	const files: AttachedFile[] = [];
	for (const part of record?.attachments ?? []) {
		const name = part.name ?? "";
		const type = part.type ?? "";
		files.push({
			bytes: await blobBytes(session, part.blobId ?? "", name, type),
			name,
			size: part.size ?? 0,
			type,
		});
	}
	return files;
};

export interface ToolAnswer {
	isError: boolean;
	text: string;
}

export type ToolCaller = (
	name: string,
	args: Record<string, unknown>
) => Promise<ToolAnswer>;

/** Calls a tool of a started server and reads the answer as an agent does. */
export const toolCaller =
	(client: Client): ToolCaller =>
	async (name, args) => {
		const result = await client.callTool({ arguments: args, name });
		const content = result.content as { text?: string }[];
		return {
			isError: result.isError === true,
			text: content.map((part) => part.text ?? "").join("\n"),
		};
	};
