// Raw JMAP for the e2e suites: seeding a mailbox and reading what arrived.
// Written against `fetch` alone, so a suite can set up and inspect a mailbox
// without going through the code it is testing.

import { ADMIN_URL } from "./env.ts";
import { pollUntil } from "./wait.ts";

export const MAIL_USING = [
	"urn:ietf:params:jmap:core",
	"urn:ietf:params:jmap:mail",
];

const NON_WORD_RE = /\W+/gu;
const QP_SOFT_BREAK_RE = /[=]\r?\n/gu;
const QP_HEX_RE = /[=]([0-9A-Fa-f]{2})/gu;

/** What a suite needs from one account's JMAP session. */
export interface MailSession {
	/** The account's id for mail methods. */
	accountId: string;
	apiUrl: string;
	/** The `Authorization` header value the session was opened with. */
	authorization: string;
	/** Capability URNs the server advertises. */
	capabilities: string[];
	downloadUrl: string;
	uploadUrl: string;
	/** The login name; for a test account, its address. */
	username: string;
}

type MethodResponse = [string, Record<string, unknown>, string];

/** Fetches the JMAP session for a credential (an `Authorization` value). */
export const openMailSession = async (
	authorization: string
): Promise<MailSession> => {
	const res = await fetch(`${ADMIN_URL}/jmap/session`, {
		headers: { authorization },
	});
	if (res.status !== 200) {
		throw new Error(`JMAP session returned HTTP ${res.status}`);
	}
	const body = (await res.json()) as {
		apiUrl: string;
		capabilities: Record<string, unknown>;
		downloadUrl: string;
		primaryAccounts: Record<string, string>;
		uploadUrl: string;
		username: string;
	};
	const accountId = body.primaryAccounts["urn:ietf:params:jmap:mail"];
	if (!accountId) {
		throw new Error("JMAP session has no mail account");
	}
	return {
		accountId,
		apiUrl: body.apiUrl,
		authorization,
		capabilities: Object.keys(body.capabilities),
		downloadUrl: body.downloadUrl,
		uploadUrl: body.uploadUrl,
		username: body.username,
	};
};

/**
 * Sends method calls as given and returns the method responses, errors
 * included. Only a non-200 HTTP status throws.
 */
export const jmapRequest = async (
	session: MailSession,
	methodCalls: [string, Record<string, unknown>, string][],
	using: string[] = MAIL_USING
): Promise<MethodResponse[]> => {
	const res = await fetch(session.apiUrl, {
		body: JSON.stringify({ methodCalls, using }),
		headers: {
			authorization: session.authorization,
			"content-type": "application/json",
		},
		method: "POST",
	});
	if (res.status !== 200) {
		throw new Error(`JMAP request returned HTTP ${res.status}`);
	}
	const body = (await res.json()) as { methodResponses?: MethodResponse[] };
	return body.methodResponses ?? [];
};

/**
 * One method call on the session's account; returns its arguments and throws
 * on a method-level error. `accountId` is filled in.
 */
export const jmapCall = async (
	session: MailSession,
	method: string,
	args: Record<string, unknown>,
	using: string[] = MAIL_USING
): Promise<Record<string, unknown>> => {
	const [response] = await jmapRequest(
		session,
		[[method, { accountId: session.accountId, ...args }, "0"]],
		using
	);
	if (!response || response[0] === "error") {
		throw new Error(`${method} failed: ${JSON.stringify(response)}`);
	}
	return response[1];
};

/**
 * Id of the mailbox with this role (`inbox`, `drafts`, `sent`, `trash`,
 * `junk`, `archive`) or, failing that, this name; both compared without case.
 */
export const mailboxId = async (
	session: MailSession,
	nameOrRole: string
): Promise<string> => {
	const result = await jmapCall(session, "Mailbox/get", {
		properties: ["name", "role"],
	});
	const list = result.list as { id: string; name: string; role?: string }[];
	const wanted = nameOrRole.toLowerCase();
	const match =
		list.find((mailbox) => mailbox.role?.toLowerCase() === wanted) ??
		list.find((mailbox) => mailbox.name.toLowerCase() === wanted);
	if (!match) {
		throw new Error(
			`no mailbox "${nameOrRole}" among ${list.map((mailbox) => mailbox.name).join(", ")}`
		);
	}
	return match.id;
};

/** Uploads bytes to the session's account and returns the blob id. */
export const uploadBlob = async (
	session: MailSession,
	content: string | Uint8Array<ArrayBuffer>,
	contentType: string
): Promise<string> => {
	const res = await fetch(
		session.uploadUrl.replace("{accountId}", session.accountId),
		{
			body: content,
			headers: {
				authorization: session.authorization,
				"content-type": contentType,
			},
			method: "POST",
		}
	);
	if (res.status !== 200) {
		throw new Error(`upload returned HTTP ${res.status}`);
	}
	return ((await res.json()) as { blobId: string }).blobId;
};

export interface MessageSourceOptions {
	body: string;
	/** The `Date` header. `importEmail` takes the received date separately. */
	date: Date;
	/** `From` header value. */
	from: string;
	/** `Message-ID` header value, angle brackets included. */
	messageId: string;
	/**
	 * Message-IDs of the conversation so far, oldest first. The last one
	 * becomes `In-Reply-To`, all of them `References`: the headers a mail
	 * server threads by.
	 */
	references?: string[];
	subject: string;
	/** `To` header value. */
	to: string;
}

/**
 * One plain-text message as its complete RFC 5322 source, for `importEmail`'s
 * `raw`. Unlike `importEmail`'s own fields it sets the Message-ID and the
 * reply headers, so several of these form a conversation.
 */
export const messageSource = (options: MessageSourceOptions): string =>
	[
		`From: ${options.from}`,
		`To: ${options.to}`,
		`Subject: ${options.subject}`,
		`Message-ID: ${options.messageId}`,
		...(options.references && options.references.length > 0
			? [
					`In-Reply-To: ${options.references.at(-1)}`,
					`References: ${options.references.join(" ")}`,
				]
			: []),
		`Date: ${options.date.toUTCString()}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		options.body,
	].join("\r\n");

export interface ImportEmailOptions {
	/** Plain-text body. Default: empty. */
	body?: string;
	/** `From` header value. Default `sender@example.com`. */
	from?: string;
	/** Further header lines, e.g. `"List-Id: <news.example.com>"`. */
	headers?: string[];
	/** Keywords the message starts with, e.g. `{ $seen: true }`. */
	keywords?: Record<string, boolean>;
	/** Mailbox role or name to file it in. Default `inbox`. */
	mailbox?: string;
	/**
	 * The complete RFC 5322 message. When given, `from`, `to`, `subject`,
	 * `body` and `headers` are ignored.
	 */
	raw?: string;
	/** Default: now. */
	receivedAt?: Date;
	subject?: string;
	/** `To` header value. Default: the account's own address. */
	to?: string;
}

/**
 * Puts one message straight into a mailbox (upload + `Email/import`), with no
 * delivery involved: no Sieve script runs and no spam filter sees it. Returns
 * the email id.
 */
export const importEmail = async (
	session: MailSession,
	options: ImportEmailOptions = {}
): Promise<string> => {
	const receivedAt = options.receivedAt ?? new Date();
	const subject = options.subject ?? "e2e message";
	const raw =
		options.raw ??
		[
			`From: ${options.from ?? "sender@example.com"}`,
			`To: ${options.to ?? session.username}`,
			`Subject: ${subject}`,
			`Message-ID: <${subject.replaceAll(NON_WORD_RE, "-")}-${Date.now()}-${Math.random().toString(36).slice(2)}@e2e.example.com>`,
			`Date: ${receivedAt.toUTCString()}`,
			...(options.headers ?? []),
			"Content-Type: text/plain; charset=utf-8",
			"",
			options.body ?? "",
		].join("\r\n");
	const [blobId, mailbox] = await Promise.all([
		uploadBlob(session, raw, "message/rfc822"),
		mailboxId(session, options.mailbox ?? "inbox"),
	]);
	const result = await jmapCall(session, "Email/import", {
		emails: {
			i0: {
				blobId,
				keywords: options.keywords ?? {},
				mailboxIds: { [mailbox]: true },
				receivedAt: receivedAt.toISOString(),
			},
		},
	});
	const id = (result.created as { i0?: { id?: string } } | undefined)?.i0?.id;
	if (!id) {
		throw new Error(`Email/import failed: ${JSON.stringify(result)}`);
	}
	return id;
};

/**
 * Undoes quoted-printable so a message reads as plain text: rejoins soft line
 * breaks and decodes `=XX` escapes. Stalwart QP-encodes the `text/calendar`
 * part of a scheduling message, so `FREQ=WEEKLY` ships as `FREQ=3DWEEKLY`.
 */
export const qpDecode = (raw: string): string =>
	raw
		.replace(QP_SOFT_BREAK_RE, "")
		.replace(QP_HEX_RE, (_match, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16))
		);

/**
 * Every message in the account, in any mailbox, as its raw RFC 5322 source
 * with quoted-printable undone (headers and all parts in one string).
 */
export const allMessages = async (session: MailSession): Promise<string[]> => {
	const responses = await jmapRequest(session, [
		["Email/query", { accountId: session.accountId }, "0"],
		[
			"Email/get",
			{
				"#ids": { name: "Email/query", path: "/ids", resultOf: "0" },
				accountId: session.accountId,
				properties: ["blobId"],
			},
			"1",
		],
	]);
	const list =
		(responses[1]?.[1]?.list as { blobId: string }[] | undefined) ?? [];
	return Promise.all(
		list.map(async ({ blobId }) => {
			const url = session.downloadUrl
				.replace("{accountId}", session.accountId)
				.replace("{blobId}", blobId)
				.replace("{name}", "message.eml")
				.replace("{type}", "message/rfc822");
			const res = await fetch(url, {
				headers: { authorization: session.authorization },
			});
			return qpDecode(await res.text());
		})
	);
};

interface WaitForMessageOptions {
	/** Pause between looks. Default 250 ms. */
	intervalMs?: number;
	/** Default 20 s: local delivery and scheduling take a few seconds. */
	timeoutMs?: number;
}

/**
 * Polls the account until a message whose decoded source satisfies `matches`
 * has arrived, and returns that source. Throws on timeout. Give the calling
 * test or hook a timeout above `timeoutMs`.
 */
export const waitForMessage = async (
	session: MailSession,
	matches: (source: string) => boolean,
	waitingFor: string,
	options: WaitForMessageOptions = {}
): Promise<string> => {
	const found = await pollUntil(
		async () => (await allMessages(session)).find(matches),
		(source) => source !== undefined,
		{
			intervalMs: options.intervalMs ?? 250,
			timeoutMs: options.timeoutMs ?? 20_000,
			waitingFor: `message for ${session.username}: ${waitingFor}`,
		}
	);
	return found as string;
};

/**
 * Waits for a calendar scheduling message (iTIP over mail) containing
 * `marker`, e.g. `METHOD:CANCEL` or a `RECURRENCE-ID:` line, and returns its
 * decoded source. Stalwart delivers these to local attendees by itself when
 * an organizer's event changes over CalDAV.
 */
export const waitForCalendarMessage = (
	session: MailSession,
	marker: string,
	options: WaitForMessageOptions = {}
): Promise<string> =>
	waitForMessage(
		session,
		(source) => source.includes("BEGIN:VCALENDAR") && source.includes(marker),
		`calendar message containing ${marker}`,
		options
	);
