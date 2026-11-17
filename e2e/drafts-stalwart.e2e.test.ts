// E2E for the composition tools against a REAL Stalwart: create_draft,
// get_draft, update_draft, send_draft, delete_draft, and reply_to_message
// driven end to end over live JMAP.
//
// This is the test that actually proves the feature, because every interesting
// claim it makes is a claim about the server. That Email/set `create` with
// bodyValues produces a message Stalwart files as a draft; that create+destroy
// in one call really replaces a draft rather than duplicating it; that
// Identity/get returns something to send as; that EmailSubmission/set accepts a
// staged draft and that its `onSuccessUpdateEmail` moves the message into Sent
// and clears `$draft`. None of that is observable against a mock.
//
// The two acceptance criteria are asserted directly: a threaded reply staged
// from a contact's message and visible in Drafts (phase 1), and that same draft
// sent, returning an id that get_email reads back in the same session (phase 2).
//
// Seeding is deterministic: a raw RFC 5322 message is uploaded and
// Email/import-ed into the Inbox (no SMTP timing). Mail is only ever sent to
// accounts of this suite on the same server — the account's own address, or
// the correspondent's, a second throwaway account — so delivery stays local.
//
// The first block runs the tools in this process on their live deps, with the
// runtime a server builds: the account's app-password credential as the token
// and the principal the JMAP session names. The blocks after it start the
// built server the way an agent does, over stdio and over HTTP, and call the
// tools through an MCP client.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import { afterAll, beforeAll, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { IdempotencyStore } from "../src/drafts/idempotency.ts";
import type { SendGuard } from "../src/drafts/send-guard.ts";
import {
	draftIdResolve,
	emailComposeGet,
	emailGetDetail,
	emailSet,
	identityGet,
	mailboxCreate,
	mailboxIdByRole,
} from "../src/jmap/index.ts";
import { createRuntime } from "../src/mcp/handler.ts";
import { createDraft, createDraftInput } from "../src/tools/create-draft.ts";
import { deleteDraft, deleteDraftInput } from "../src/tools/delete-draft.ts";
import {
	type DraftToolDeps,
	makeLiveDeps as makeDraftDeps,
} from "../src/tools/draft-common.ts";
import { getDraft, getDraftInput } from "../src/tools/get-draft.ts";
import {
	type GetEmailDeps,
	getEmail,
	getEmailInput,
	makeLiveDeps as makeGetEmailDeps,
} from "../src/tools/get-email.ts";
import { listDrafts, listDraftsInput } from "../src/tools/list-drafts.ts";
import {
	replyToMessage,
	replyToMessageInput,
} from "../src/tools/reply-to-message.ts";
import { sendDraft, sendDraftInput } from "../src/tools/send-draft.ts";
import { updateDraft, updateDraftInput } from "../src/tools/update-draft.ts";
import {
	createAccount,
	createBearerCredential,
	destroyCreatedAccounts,
	type TestAccount,
	uniqueLocalPart,
} from "./support/admin.ts";
import {
	awaitDelivery,
	awaitSubject,
	bodyOf,
	composeRecord,
	DRAFT_ID_RE,
	idsIn,
	MESSAGE_ID_RE,
	type ToolCaller,
	toolCaller,
	withSubject,
} from "./support/compose.ts";
import { ADMIN_URL, live } from "./support/env.ts";
import {
	importEmail,
	type MailSession,
	mailboxId,
	openMailSession,
} from "./support/mail.ts";
import { startHttpServer, startStdioServer } from "./support/server.ts";
import { untilIndexed } from "./support/wait.ts";

// Search indexing lags a write, and other suites load the same server.
const INDEX_BUDGET_MS = 30_000;

const RECEIVED_AT = new Date("2026-07-21T10:00:00Z");

live(
	"composition tools against live Stalwart — draft, edit, send, reply",
	() => {
		const run = Date.now();
		// An invented correspondent: a second throwaway account on the same
		// server, so the reply that is sent to it is delivered locally.
		const CORRESPONDENT_NAME = "Nadia Bram";
		let correspondentAddress: string;
		let correspondent: string;
		let correspondentSession: MailSession;
		let address: string;
		let authorization: string;
		let accountId: string;
		let apiUrl: string;
		let session: MailSession;
		let inboxId: string;
		let draftsId: string;
		let sentId: string;
		let deps: DraftToolDeps;
		let getEmailDeps: GetEmailDeps;
		let originalId: string;
		let replays: IdempotencyStore<string>;
		let guard: SendGuard;

		const ctx = () => ({ accountId, apiUrl, authorization });
		const toolCtx = { principal: "", token: "" };

		beforeAll(async () => {
			const account = await createAccount({
				localPart: uniqueLocalPart("mcp-drafts-e2e"),
			});
			const other = await createAccount({
				localPart: uniqueLocalPart("mcp-drafts-nadia"),
			});
			address = account.address;
			authorization = account.authorization;
			correspondentAddress = other.address;
			correspondent = `${CORRESPONDENT_NAME} <${correspondentAddress}>`;
			correspondentSession = await openMailSession(other.authorization);

			session = await openMailSession(authorization);
			({ accountId, apiUrl } = session);

			// The runtime a stdio server builds for this account: its credential is
			// the token every tool receives, and signing in names the principal.
			const { config } = loadConfig({
				STALWART_PASSWORD: account.secret,
				STALWART_URL: ADMIN_URL,
				STALWART_USERNAME: address,
			});
			const runtime = createRuntime(config);
			await runtime.signIn();
			expect(runtime.getPrincipal()).toBe(address);
			toolCtx.principal = runtime.getPrincipal();
			toolCtx.token = runtime.getToken();
			replays = runtime.composeReplays;
			guard = runtime.sendGuard;

			inboxId =
				(await mailboxIdByRole({ ...ctx(), role: "inbox" })) ??
				(await mailboxCreate({ ...ctx(), name: "Inbox", role: "inbox" }));
			draftsId =
				(await mailboxIdByRole({ ...ctx(), role: "drafts" })) ??
				(await mailboxCreate({ ...ctx(), name: "Drafts", role: "drafts" }));
			sentId =
				(await mailboxIdByRole({ ...ctx(), role: "sent" })) ??
				(await mailboxCreate({ ...ctx(), name: "Sent", role: "sent" }));

			originalId = await importEmail(session, {
				raw: [
					`From: ${correspondent}`,
					`To: ${address}`,
					"Subject: Quarterly numbers",
					`Message-ID: <original-${run}@example.com>`,
					"Date: Tue, 21 Jul 2026 10:00:00 +0000",
					"",
					"Could you confirm the Q2 figures?",
				].join("\r\n"),
				receivedAt: RECEIVED_AT,
			});

			// The deps the server registers the tools with.
			deps = makeDraftDeps(runtime.jmapLive);
			getEmailDeps = makeGetEmailDeps(runtime.jmapLive);
		});

		afterAll(async () => {
			await destroyCreatedAccounts();
		});

		test("the account has a sending identity to compose as", async () => {
			const identities = await identityGet({ ...ctx() });
			// Everything downstream needs one; failing here rather than inside a tool
			// makes a Stalwart that stops auto-provisioning identities obvious.
			expect(identities.length).toBeGreaterThan(0);
			expect(identities.map((i) => i.email.toLowerCase())).toContain(
				address.toLowerCase()
			);
		});

		// --- acceptance criterion, phase 1 ---------------------------------------

		let replyDraftId = "";
		let replyEmailId = "";

		test("create_draft stages a correctly threaded reply that lands in Drafts unsent", async () => {
			const result = await createDraft(deps, replays, {
				...toolCtx,
				args: createDraftInput.parse({
					inReplyTo: originalId,
					text: "Confirmed — the Q2 figures are final.",
				}),
			});
			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("Nothing has been sent");
			// The recipient was derived from the message being replied to.
			expect(text).toContain(correspondentAddress);
			expect(text).toContain("subject: Re: Quarterly numbers");

			replyDraftId = DRAFT_ID_RE.exec(text)?.[1] ?? "";
			expect(replyDraftId).not.toBe("");
			// The draftId is a token the message carries as a keyword.
			replyEmailId =
				(await draftIdResolve({ ...ctx(), draftId: replyDraftId })) ?? "";
			expect(replyEmailId).not.toBe("");

			// Stalwart filed it as a draft, in the Drafts mailbox, with the threading
			// headers set — which is what makes it look human-written in a client.
			const record = await emailComposeGet({
				...ctx(),
				id: replyEmailId,
				maxBodyValueBytes: 10_000,
			});
			expect(record?.keywords?.$draft).toBe(true);
			expect(record?.mailboxIds?.[draftsId]).toBe(true);
			expect(record?.inReplyTo).toEqual([`original-${run}@example.com`]);
			expect(record?.references).toEqual([`original-${run}@example.com`]);
			expect(record?.to?.[0]?.email).toBe(correspondentAddress);
			// It goes out as the principal: the address the session named.
			expect(record?.from?.[0]?.email).toBe(address);
			expect(await idsIn(session, draftsId)).toContain(replyEmailId);

			// Stalwart threaded the reply onto the original conversation.
			const [original] = await emailGetDetail({
				...ctx(),
				ids: [originalId],
				maxBodyValueBytes: 1,
			});
			expect(record?.threadId).toBe(original?.threadId);
		});

		test("get_draft reads the staged reply back", async () => {
			const result = await getDraft(deps, {
				args: getDraftInput.parse({ draftId: replyDraftId }),
				token: toolCtx.token,
			});
			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("Draft (not sent):");
			expect(text).toContain("Confirmed — the Q2 figures are final.");
		});

		test("update_draft keeps the draftId: one draft in Drafts, read back by the same id", async () => {
			const result = await updateDraft(deps, {
				args: updateDraftInput.parse({
					draftId: replyDraftId,
					subject: "Re: Quarterly numbers (final)",
				}),
				...toolCtx,
			});
			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.text ?? "";
			expect(text).not.toContain("could not be removed");
			expect(DRAFT_ID_RE.exec(text)?.[1]).toBe(replyDraftId);

			// The edit replaced the message rather than leaving two drafts behind: the
			// first revision is gone, and the draftId now names its replacement.
			const inDrafts = await idsIn(session, draftsId);
			expect(inDrafts).not.toContain(replyEmailId);
			const current = await draftIdResolve({
				...ctx(),
				draftId: replyDraftId,
			});
			expect(current).not.toBeNull();
			expect(current).not.toBe(replyEmailId);
			expect(inDrafts).toContain(current ?? "");

			const record = await emailComposeGet({
				...ctx(),
				id: current ?? "",
				maxBodyValueBytes: 10_000,
			});
			expect(record?.subject).toBe("Re: Quarterly numbers (final)");
			// The body and the threading survived an edit that named neither.
			expect(record?.inReplyTo).toEqual([`original-${run}@example.com`]);

			const read = await getDraft(deps, {
				args: getDraftInput.parse({ draftId: replyDraftId }),
				token: toolCtx.token,
			});
			expect(read.content[0]?.text).toContain("Re: Quarterly numbers (final)");
		});

		test("update_draft rewords a reply and keeps the quoted original below it", async () => {
			const result = await updateDraft(deps, {
				args: updateDraftInput.parse({
					draftId: replyDraftId,
					text: "Confirmed.",
				}),
				...toolCtx,
			});
			expect(result.isError).toBeUndefined();
			expect(DRAFT_ID_RE.exec(result.content[0]?.text ?? "")?.[1]).toBe(
				replyDraftId
			);

			const current = await draftIdResolve({
				...ctx(),
				draftId: replyDraftId,
			});
			const record = await emailComposeGet({
				...ctx(),
				id: current ?? "",
				maxBodyValueBytes: 10_000,
			});
			const body = Object.values(record?.bodyValues ?? {})[0]?.value ?? "";
			expect(body.startsWith("Confirmed.")).toBe(true);
			expect(body).not.toContain("the Q2 figures are final");
			expect(body).toContain("wrote:");
			expect(body).toContain("> ");
		});

		test("list_drafts finds the edited reply once, by its draftId, and narrows by recipient", async () => {
			const list = async (args: Record<string, unknown>) =>
				(
					await listDrafts(deps, {
						args: listDraftsInput.parse(args),
						token: toolCtx.token,
					})
				).content[0]?.text ?? "";

			const all = await list({});
			// Edits replaced the revision each time, so the draftId appears once.
			expect(all.split(`draftId: ${replyDraftId}`)).toHaveLength(2);
			const current = await draftIdResolve({
				...ctx(),
				draftId: replyDraftId,
			});
			expect(all).toContain(`messageId: ${current}`);
			expect(all).toContain(`reply to: message ${originalId}`);

			// The nested OR over subject and recipients, and the date window, are
			// conditions Stalwart has to evaluate — a fixture cannot prove them.
			// Stalwart indexes for search asynchronously, so the revision
			// update_draft just wrote turns up in a text query a moment later: poll.
			const listUntil = (
				args: Record<string, unknown>,
				needle: string
			): Promise<string> =>
				untilIndexed(
					() => list(args),
					(text) => text.includes(needle),
					needle,
					INDEX_BUDGET_MS
				);
			expect(
				await listUntil(
					{ query: correspondentAddress },
					`draftId: ${replyDraftId}`
				)
			).toContain(`draftId: ${replyDraftId}`);
			// Stalwart matches whole words — a display name, an address, a subject
			// word — and not fragments of one, which is what the query description
			// promises.
			expect(await list({ query: "Nadia" })).toContain(
				`draftId: ${replyDraftId}`
			);
			expect(await list({ query: "adia" })).toBe("No drafts matched.");
			expect(await list({ query: "(final)" })).toContain(
				`draftId: ${replyDraftId}`
			);
			expect(await list({ query: "no-such-recipient.example" })).toBe(
				"No drafts matched."
			);
			expect(await list({ before: "2000-01-01T00:00:00Z" })).toBe(
				"No drafts matched."
			);
			expect(await list({ after: "2000-01-01T00:00:00Z" })).toContain(
				`draftId: ${replyDraftId}`
			);

			// A copy another client left in Trash as well as Drafts is one the draft
			// tools refuse as discarded, so the listing must leave it out too — the
			// NOT filter is the server's to evaluate. The live deps find the Trash
			// folder by its role, so it only has to exist.
			const trashId =
				(await mailboxIdByRole({ ...ctx(), role: "trash" })) ??
				(await mailboxCreate({ ...ctx(), name: "Trash", role: "trash" }));
			expect((await deps.resolveComposeMailboxes(toolCtx.token)).trash).toBe(
				trashId
			);
			expect(await list({})).toContain(`messageId: ${current}`);
			await emailSet({
				...ctx(),
				changes: { mailboxIds: { [trashId]: true } },
				id: current ?? "",
			});
			try {
				expect(await list({})).not.toContain(`messageId: ${current}`);
			} finally {
				await emailSet({
					...ctx(),
					changes: { mailboxIds: { [trashId]: false } },
					id: current ?? "",
				});
			}
		});

		test("send_draft by the draftId sends the edited revision, once", async () => {
			const before = await idsIn(
				correspondentSession,
				await mailboxId(correspondentSession, "inbox")
			);
			const current =
				(await draftIdResolve({ ...ctx(), draftId: replyDraftId })) ?? "";
			const sent = await sendDraft(deps, replays, guard, {
				...toolCtx,
				args: sendDraftInput.parse({ draftId: replyDraftId }),
			});
			expect(sent.isError).toBeUndefined();
			expect(MESSAGE_ID_RE.exec(sent.content[0]?.text ?? "")?.[1]).toBe(
				current
			);

			const again = await sendDraft(deps, replays, guard, {
				...toolCtx,
				args: sendDraftInput.parse({ draftId: replyDraftId }),
			});
			expect(again.isError).toBe(true);
			expect(again.content[0]?.text).toContain("already been sent");

			// The correspondent is an account on this server: the reply arrives
			// there, from the principal's address, as one message.
			const inbox = await mailboxId(correspondentSession, "inbox");
			const delivered = await awaitDelivery(
				correspondentSession,
				inbox,
				before
			);
			expect(delivered).toHaveLength(1);
			const arrived = await composeRecord(
				correspondentSession,
				delivered[0] ?? ""
			);
			expect(arrived?.subject).toBe("Re: Quarterly numbers (final)");
			expect(arrived?.from?.[0]?.email).toBe(address);
			expect(arrived?.inReplyTo).toEqual([`original-${run}@example.com`]);
		});

		// --- acceptance criterion, phase 2 ---------------------------------------

		test("send_draft sends a staged draft and get_email reads it back in the same session", async () => {
			// Addressed to the account itself so delivery stays inside the server.
			const staged = await createDraft(deps, replays, {
				...toolCtx,
				args: createDraftInput.parse({
					subject: "Self test",
					text: "Body of the sent message.",
					to: [address],
				}),
			});
			const draftId =
				DRAFT_ID_RE.exec(staged.content[0]?.text ?? "")?.[1] ?? "";
			expect(draftId).not.toBe("");

			const result = await sendDraft(deps, replays, guard, {
				...toolCtx,
				args: sendDraftInput.parse({ draftId }),
			});
			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("Sent.");

			const messageId = MESSAGE_ID_RE.exec(text)?.[1] ?? "";
			// The Email id survives the move, so the message the draftId named is the
			// sent message.
			expect(messageId).toBe(
				(await draftIdResolve({ ...ctx(), draftId })) ?? ""
			);

			// onSuccessUpdateEmail moved it out of Drafts into Sent and cleared $draft.
			const record = await emailComposeGet({
				...ctx(),
				id: messageId,
				maxBodyValueBytes: 10_000,
			});
			expect(record?.mailboxIds?.[sentId]).toBe(true);
			expect(record?.mailboxIds?.[draftsId]).toBeUndefined();
			expect(record?.keywords?.$draft).toBeUndefined();

			// …and get_email reads the sent message back by that id.
			const read = await getEmail(getEmailDeps, {
				args: getEmailInput.parse({ id: messageId }),
				token: toolCtx.token,
			});
			expect(read.isError).toBeUndefined();
			const body = read.content[0]?.text ?? "";
			expect(body).toContain("Subject: Self test");
			expect(body).toContain("Body of the sent message.");

			// Stalwart generated a Message-ID for the message it assembled. Without one,
			// a reply to this message would derive empty threading headers and silently
			// start a new conversation (`replyThreading` reads `messageId`).
			expect(record?.messageId?.[0]).toBeTruthy();
		});

		test("a bcc recipient is delivered but does not appear in the delivered message", async () => {
			// The claim this pins down is Stalwart's, not the RFC's: omitting the
			// envelope has the server derive rcptTo from To/Cc/Bcc, and stripping the
			// Bcc header from the transmitted copy is then up to the server. If it
			// didn't, every To recipient would see the blind ones — so assert it rather
			// than assume it.
			const before = await idsIn(session, inboxId);
			const staged = await createDraft(deps, replays, {
				...toolCtx,
				args: createDraftInput.parse({
					bcc: [address],
					subject: "Bcc test",
					text: "Body with a blind recipient.",
					to: [address],
				}),
			});
			const draftId =
				DRAFT_ID_RE.exec(staged.content[0]?.text ?? "")?.[1] ?? "";
			const sent = await sendDraft(deps, replays, guard, {
				...toolCtx,
				args: sendDraftInput.parse({ draftId }),
			});
			expect(sent.isError).toBeUndefined();

			// The Sent copy keeps bcc — that copy is the user's own record.
			const sentCopy = await emailComposeGet({
				...ctx(),
				id: MESSAGE_ID_RE.exec(sent.content[0]?.text ?? "")?.[1] ?? "",
				maxBodyValueBytes: 10_000,
			});
			expect(sentCopy?.bcc?.[0]?.email).toBe(address);

			// The delivered copy is a different Email; it must carry no bcc at all.
			// Local delivery is asynchronous, so it is awaited, not assumed.
			const delivered = await awaitDelivery(session, inboxId, before);
			expect(delivered.length).toBeGreaterThan(0);
			for (const id of delivered) {
				const record = await emailComposeGet({
					...ctx(),
					id,
					maxBodyValueBytes: 10,
				});
				expect(record?.bcc ?? null).toBeNull();
			}
		});

		test("send_draft refuses to send the same draft twice", async () => {
			const staged = await createDraft(deps, replays, {
				...toolCtx,
				args: createDraftInput.parse({
					subject: "Once only",
					text: "Sent exactly once.",
					to: [address],
				}),
			});
			const draftId =
				DRAFT_ID_RE.exec(staged.content[0]?.text ?? "")?.[1] ?? "";

			const first = await sendDraft(deps, replays, guard, {
				...toolCtx,
				args: sendDraftInput.parse({ draftId }),
			});
			expect(first.isError).toBeUndefined();

			// No idempotency key involved: the guard is that the message is no longer a
			// draft, which is state Stalwart holds.
			const second = await sendDraft(deps, replays, guard, {
				...toolCtx,
				args: sendDraftInput.parse({ draftId }),
			});
			expect(second.isError).toBe(true);
			expect(second.content[0]?.text ?? "").toContain("already been sent");
		});

		test("delete_draft removes a draft for good: get_draft and the Drafts folder no longer see it", async () => {
			const staged = await createDraft(deps, replays, {
				...toolCtx,
				args: createDraftInput.parse({
					subject: "Superseded",
					text: "The longer version.",
					to: [address],
				}),
			});
			const draftId =
				DRAFT_ID_RE.exec(staged.content[0]?.text ?? "")?.[1] ?? "";
			const emailId = (await draftIdResolve({ ...ctx(), draftId })) ?? "";
			expect(await idsIn(session, draftsId)).toContain(emailId);

			const result = await deleteDraft(deps, guard, {
				...toolCtx,
				args: deleteDraftInput.parse({ draftId }),
			});
			expect(result.isError).toBeUndefined();
			expect(await idsIn(session, draftsId)).not.toContain(emailId);
			const after = await getDraft(deps, {
				args: getDraftInput.parse({ draftId }),
				token: toolCtx.token,
			});
			expect(after.isError).toBe(true);
			expect(after.content[0]?.text ?? "").toContain("Draft not found");
		});

		test("delete_draft refuses a sent message and leaves it in Sent", async () => {
			const staged = await createDraft(deps, replays, {
				...toolCtx,
				args: createDraftInput.parse({
					subject: "Keep me",
					text: "Already gone out.",
					to: [address],
				}),
			});
			const draftId =
				DRAFT_ID_RE.exec(staged.content[0]?.text ?? "")?.[1] ?? "";
			const sent = await sendDraft(deps, replays, guard, {
				...toolCtx,
				args: sendDraftInput.parse({ draftId }),
			});
			const messageId =
				MESSAGE_ID_RE.exec(sent.content[0]?.text ?? "")?.[1] ?? "";
			expect(messageId).not.toBe("");

			const result = await deleteDraft(deps, guard, {
				...toolCtx,
				args: deleteDraftInput.parse({ draftId }),
			});
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text ?? "").toContain(
				"already been sent or received"
			);
			expect(result.content[0]?.text ?? "").toContain("Nothing was deleted.");
			expect(await idsIn(session, sentId)).toContain(messageId);
		});

		test("reply_to_message sends a threaded reply in one call", async () => {
			const result = await replyToMessage(deps, replays, guard, {
				...toolCtx,
				// Addressed to the account itself, so the reply is delivered locally
				// and the whole path stays inside the server.
				args: replyToMessageInput.parse({
					messageId: originalId,
					text: "One-shot reply.",
					to: [address],
				}),
			});
			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("Reply sent.");

			const messageId = MESSAGE_ID_RE.exec(text)?.[1] ?? "";
			const record = await emailComposeGet({
				...ctx(),
				id: messageId,
				maxBodyValueBytes: 10_000,
			});
			expect(record?.mailboxIds?.[sentId]).toBe(true);
			expect(record?.keywords?.$draft).toBeUndefined();
			expect(record?.inReplyTo).toEqual([`original-${run}@example.com`]);
			expect(record?.subject).toBe("Re: Quarterly numbers");
		});

		test("reply_to_message refuses replyAll combined with explicit recipients, sending nothing", async () => {
			const before = await idsIn(session, sentId);
			const result = await replyToMessage(deps, replays, guard, {
				...toolCtx,
				args: replyToMessageInput.parse({
					messageId: originalId,
					replyAll: true,
					text: "nope",
					to: [address],
				}),
			});
			expect(result.isError).toBe(true);
			expect(await idsIn(session, sentId)).toEqual(before);
		});
	}
);

// --- the built server, as an agent runs it ---------------------------------

interface Mailbox {
	account: TestAccount;
	inbox: string;
	sent: string;
	session: MailSession;
}

const openMailbox = async (name: string): Promise<Mailbox> => {
	const account = await createAccount({ localPart: uniqueLocalPart(name) });
	const session = await openMailSession(account.authorization);
	return {
		account,
		inbox: await mailboxId(session, "inbox"),
		sent: await mailboxId(session, "sent"),
		session,
	};
};

const idFrom = (text: string, pattern: RegExp): string => {
	const id = pattern.exec(text)?.[1];
	expect(id).toBeDefined();
	return id as string;
};

interface Started {
	call: ToolCaller;
	stop: () => Promise<unknown>;
}

type Start = (
	account: TestAccount,
	env?: Record<string, string>
) => Promise<Started>;

const overStdio: Start = async (account, env = {}) => {
	const server = await startStdioServer(account, { env });
	return { call: toolCaller(server.client), stop: server.stop };
};

const overHttp: Start = async (account, env = {}) => {
	const server = await startHttpServer(account, { env });
	return { call: toolCaller(server.client), stop: server.stop };
};

// The whole path a user's agent takes, against a server it started itself:
// stage, read back, revise, send — and the message the other person gets.
const composingOverTheBuiltServer = (transport: string, start: Start): void => {
	live(`composing and sending with the built server over ${transport}`, () => {
		const run = Date.now();
		let sender: Mailbox;
		let recipient: Mailbox;
		let server: Started;
		let call: ToolCaller;

		beforeAll(async () => {
			sender = await openMailbox(`drafts-${transport}-from`);
			recipient = await openMailbox(`drafts-${transport}-to`);
			server = await start(sender.account);
			({ call } = server);
		});

		afterAll(async () => {
			await server?.stop();
			await destroyCreatedAccounts();
		});

		test("create_draft, get_draft, update_draft, send_draft: the other account receives the revised message, from the sender's address", async () => {
			const subject = `Site visit ${transport} ${run}`;
			const staged = await call("create_draft", {
				subject: `${subject} (draft)`,
				text: "Thursday at ten works for us.",
				to: [recipient.account.address],
			});
			expect(staged.isError).toBe(false);
			expect(staged.text).toContain("Nothing has been sent");
			const draftId = idFrom(staged.text, DRAFT_ID_RE);

			const read = await call("get_draft", { draftId });
			expect(read.isError).toBe(false);
			expect(read.text).toContain("Draft (not sent):");
			expect(read.text).toContain("Thursday at ten works for us.");
			expect(read.text).toContain(recipient.account.address);

			const revised = await call("update_draft", {
				draftId,
				subject,
				text: "Thursday at eleven works for us.",
			});
			expect(revised.isError).toBe(false);
			expect(idFrom(revised.text, DRAFT_ID_RE)).toBe(draftId);

			const listed = await call("list_drafts", {});
			expect(listed.isError).toBe(false);
			expect(listed.text.split(`draftId: ${draftId}`)).toHaveLength(2);

			// Nothing has left the mailbox so far.
			expect(await idsIn(recipient.session, recipient.inbox)).toEqual([]);

			const sent = await call("send_draft", { draftId });
			expect(sent.isError).toBe(false);
			expect(sent.text).toContain("Sent.");
			const messageId = idFrom(sent.text, MESSAGE_ID_RE);
			expect(await idsIn(sender.session, sender.sent)).toContain(messageId);

			const [arrived, ...copies] = await awaitSubject(
				recipient.session,
				recipient.inbox,
				subject
			);
			expect(copies).toEqual([]);
			expect(arrived?.from?.map((from) => from.email)).toEqual([
				sender.account.address,
			]);
			expect(arrived?.to?.map((to) => to.email)).toEqual([
				recipient.account.address,
			]);
			const body = bodyOf(arrived ?? null);
			expect(body).toContain("Thursday at eleven works for us.");
			expect(body).not.toContain("Thursday at ten");
		});

		test("reply_to_message threads at the recipient: In-Reply-To and References name the message replied to", async () => {
			// The recipient wrote first. Their own copy sits in their Sent folder,
			// the delivered one in the sender's Inbox.
			const messageId = `<question-${transport}-${run}@e2e.example.com>`;
			const raw = [
				`From: ${recipient.account.address}`,
				`To: ${sender.account.address}`,
				`Subject: Parking ${transport} ${run}`,
				`Message-ID: ${messageId}`,
				"Date: Tue, 21 Jul 2026 10:00:00 +0000",
				"",
				"Is there parking at the site?",
			].join("\r\n");
			const asked = await importEmail(recipient.session, {
				mailbox: "sent",
				raw,
				receivedAt: RECEIVED_AT,
			});
			const received = await importEmail(sender.session, {
				raw,
				receivedAt: RECEIVED_AT,
			});
			const before = await idsIn(recipient.session, recipient.inbox);

			const reply = await call("reply_to_message", {
				messageId: received,
				text: "Yes, behind the building.",
			});
			expect(reply.isError).toBe(false);
			expect(reply.text).toContain("Reply sent.");

			const delivered = await awaitDelivery(
				recipient.session,
				recipient.inbox,
				before
			);
			expect(delivered).toHaveLength(1);
			const arrived = await composeRecord(
				recipient.session,
				delivered[0] ?? ""
			);
			const bare = messageId.slice(1, -1);
			expect(arrived?.inReplyTo).toEqual([bare]);
			expect(arrived?.references).toEqual([bare]);
			expect(arrived?.subject).toBe(`Re: Parking ${transport} ${run}`);
			expect(arrived?.from?.map((from) => from.email)).toEqual([
				sender.account.address,
			]);
			expect(bodyOf(arrived)).toContain("Yes, behind the building.");
			// The recipient's server files it in the conversation they started.
			const question = await composeRecord(recipient.session, asked);
			expect(arrived?.threadId).toBe(question?.threadId);
		});

		test("send_draft called twice for one draft, at once and again afterwards, delivers one message", async () => {
			const subject = `Only once ${transport} ${run}`;
			const staged = await call("create_draft", {
				subject,
				text: "This must arrive a single time.",
				to: [recipient.account.address],
			});
			const draftId = idFrom(staged.text, DRAFT_ID_RE);

			// A client that retries while its first call is still running. Over
			// HTTP the two calls reach two servers built for their requests; the
			// reservation they share lives in the process.
			const answers = await Promise.all([
				call("send_draft", { draftId }),
				call("send_draft", { draftId }),
			]);
			const sent = answers.filter((answer) => !answer.isError);
			expect(sent).toHaveLength(1);
			expect(sent[0]?.text).toContain("Sent.");
			const refused = answers.find((answer) => answer.isError);
			expect(refused?.text).toContain("Nothing was sent");

			const later = await call("send_draft", { draftId });
			expect(later.isError).toBe(true);
			expect(later.text).toContain("already been sent");

			// A message sent after those calls has arrived: a second copy of the
			// first would have been delivered ahead of it.
			const marker = `After only once ${transport} ${run}`;
			const next = await call("create_draft", {
				subject: marker,
				text: "Sent after the retries.",
				to: [recipient.account.address],
			});
			const followUp = await call("send_draft", {
				draftId: idFrom(next.text, DRAFT_ID_RE),
			});
			expect(followUp.isError).toBe(false);
			await awaitSubject(recipient.session, recipient.inbox, marker);
			expect(
				await awaitSubject(recipient.session, recipient.inbox, subject)
			).toHaveLength(1);
			expect(
				await withSubject(sender.session, sender.sent, subject)
			).toHaveLength(1);
		});

		test("a retry with the same idempotencyKey gets the first answer back and nothing is sent again", async () => {
			const subject = `Keyed ${transport} ${run}`;
			const staged = await call("create_draft", {
				subject,
				text: "Sent under a key.",
				to: [recipient.account.address],
			});
			const draftId = idFrom(staged.text, DRAFT_ID_RE);
			const key = `send-${transport}-${run}`;

			const first = await call("send_draft", { draftId, idempotencyKey: key });
			expect(first.isError).toBe(false);
			const retry = await call("send_draft", { draftId, idempotencyKey: key });
			expect(retry.isError).toBe(false);
			expect(retry.text.startsWith(first.text)).toBe(true);
			expect(retry.text).toContain("was NOT sent again");

			const marker = `After keyed ${transport} ${run}`;
			const next = await call("create_draft", {
				subject: marker,
				text: "Sent after the keyed retry.",
				to: [recipient.account.address],
			});
			await call("send_draft", { draftId: idFrom(next.text, DRAFT_ID_RE) });
			await awaitSubject(recipient.session, recipient.inbox, marker);
			expect(
				await awaitSubject(recipient.session, recipient.inbox, subject)
			).toHaveLength(1);
		});
	});
};

composingOverTheBuiltServer("stdio", overStdio);
composingOverTheBuiltServer("http", overHttp);

// --- who the mail is from ----------------------------------------------------

// The From address is the principal: the `username` of the JMAP session,
// which Stalwart sets to the account's primary address whatever was typed as
// the login name. These run the built server with each way of signing in.
live("the From address of the built server, by how it signed in", () => {
	const run = Date.now();
	let sender: Mailbox;
	let recipient: Mailbox;
	let alias: string;

	beforeAll(async () => {
		const localPart = uniqueLocalPart("drafts-identity");
		const account = await createAccount({
			aliases: [`${localPart}-alias`],
			localPart,
		});
		alias = `${localPart}-alias@example.com`;
		const session = await openMailSession(account.authorization);
		sender = {
			account,
			inbox: await mailboxId(session, "inbox"),
			sent: await mailboxId(session, "sent"),
			session,
		};
		recipient = await openMailbox("drafts-identity-to");
	});

	afterAll(async () => {
		await destroyCreatedAccounts();
	});

	// Stages and sends one message, and returns the From the recipient sees.
	const sendOne = async (
		call: ToolCaller,
		subject: string,
		from?: string
	): Promise<string[]> => {
		const staged = await call("create_draft", {
			...(from ? { from } : {}),
			subject,
			text: "Who is this from?",
			to: [recipient.account.address],
		});
		expect(staged.isError).toBe(false);
		const sent = await call("send_draft", {
			draftId: idFrom(staged.text, DRAFT_ID_RE),
		});
		expect(sent.isError).toBe(false);
		const [arrived] = await awaitSubject(
			recipient.session,
			recipient.inbox,
			subject
		);
		return (arrived?.from ?? []).map((address) => address.email);
	};

	test("an account with an alias sends from its primary address, and from the alias when `from` names it", async () => {
		const server = await overStdio(sender.account);
		try {
			expect(await sendOne(server.call, `Primary ${run}`)).toEqual([
				sender.account.address,
			]);
			expect(await sendOne(server.call, `Alias ${run}`, alias)).toEqual([
				alias,
			]);
			const refused = await server.call("create_draft", {
				from: recipient.account.address,
				subject: `Not mine ${run}`,
				text: "x",
				to: [recipient.account.address],
			});
			expect(refused.isError).toBe(true);
			expect(refused.text).toContain("cannot send as");
		} finally {
			await server.stop();
		}
	});

	test("signed in with the alias as the login name, it still sends from the primary address", async () => {
		const server = await overStdio(sender.account, {
			STALWART_USERNAME: alias,
		});
		try {
			expect(await sendOne(server.call, `Alias login ${run}`)).toEqual([
				sender.account.address,
			]);
		} finally {
			await server.stop();
		}
	});

	test("signed in with an API key (STALWART_TOKEN), it sends from the account's address", async () => {
		const bearer = await createBearerCredential(sender.account);
		const server = await overStdio(sender.account, {
			STALWART_PASSWORD: "",
			STALWART_TOKEN: bearer.slice("Bearer ".length),
			STALWART_USERNAME: "",
		});
		try {
			expect(await sendOne(server.call, `API key ${run}`)).toEqual([
				sender.account.address,
			]);
		} finally {
			await server.stop();
		}
	});
});
