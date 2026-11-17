// E2E for draft attachments against a REAL Stalwart: stage a generated file
// onto a draft, forward one that is already in the mailbox by blobId, edit the
// draft without losing either, and send it — asserting at each step that the
// bytes Stalwart holds are the bytes the fixture started with.
//
// Every claim this feature makes is a claim about the server, which is why the
// test is here and not against a mock. That `blobUpload` returns a handle
// `Email/set` will accept as an `attachments` entry. That a blobId lifted off a
// *received* message can be referenced by a *new* one, which is the whole
// forwarding story — nothing is downloaded, nothing is re-uploaded, and the
// bytes never enter the conversation. That an edit re-referencing those blobs
// produces a message whose attachment is still byte-identical, even though
// RFC 8621 made update mean create-and-destroy. And that the file survives
// EmailSubmission all the way into the recipient's Inbox: a draft that carries
// an invoice but delivers a message that doesn't is the failure this whole
// feature would be worth nothing against.
//
// Seeding is deterministic: the raw RFC 5322 MIME is built from the shared
// attachment fixtures and Email/import-ed into the Inbox, so nothing waits on
// SMTP. Mail is only ever sent to accounts of this suite on the same server,
// so delivery stays local; drafts addressed elsewhere are never sent.
//
// The first block runs the tools and the upload route in this process, on
// their live deps, with the runtime a server builds. The blocks after it
// start the built server the way an agent does, over stdio and over HTTP,
// call the tools through an MCP client and PUT the file with a plain `fetch`,
// as `curl -T` would.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { MAX_ATTACHMENT_BYTES } from "../src/drafts/attachments.ts";
import type { IdempotencyStore } from "../src/drafts/idempotency.ts";
import type { SendGuard } from "../src/drafts/send-guard.ts";
import { createRequestGuard } from "../src/http/guard.ts";
import { createFetchHandler, type FetchHandler } from "../src/http/routes.ts";
import {
	draftIdResolve,
	type EmailComposeRecord,
	emailComposeGet,
	mailboxCreate,
	mailboxIdByRole,
} from "../src/jmap/index.ts";
import { createRuntime, type ServerRuntime } from "../src/mcp/handler.ts";
import { linkRoutes } from "../src/mcp/links.ts";
import { createDraft, createDraftInput } from "../src/tools/create-draft.ts";
import {
	attachmentsFromRecord,
	type DraftToolDeps,
	makeLiveDeps as makeDraftDeps,
} from "../src/tools/draft-common.ts";
import {
	forwardMessage,
	forwardMessageInput,
} from "../src/tools/forward-message.ts";
import { getDraft, getDraftInput } from "../src/tools/get-draft.ts";
import {
	type GetEmailDeps,
	getEmail,
	getEmailInput,
	makeLiveDeps as makeGetEmailDeps,
} from "../src/tools/get-email.ts";
import { sendDraft, sendDraftInput } from "../src/tools/send-draft.ts";
import { updateDraft, updateDraftInput } from "../src/tools/update-draft.ts";
import {
	createAccount,
	destroyCreatedAccounts,
	type TestAccount,
	uniqueLocalPart,
} from "./support/admin.ts";
import {
	type AttachedFile,
	attachmentsOf,
	awaitDelivery,
	awaitSubject,
	blobBytes,
	bodyOf,
	composeRecord,
	DRAFT_ID_RE,
	idsIn,
	MESSAGE_ID_RE,
	type ToolCaller,
	toolCaller,
} from "./support/compose.ts";
import { ADMIN_URL, live } from "./support/env.ts";
import {
	importEmail,
	type MailSession,
	mailboxId,
	openMailSession,
} from "./support/mail.ts";
import { startHttpServer, startStdioServer } from "./support/server.ts";

const PUBLIC = "https://mcp.example.com";
const PUBLIC_HOST = "mcp.example.com";
const LOOPBACK = "127.0.0.1";

// An invented correspondent. Nothing in this file is sent to this address:
// the drafts addressed to it stay drafts.
const CORRESPONDENT = "Nadia Bram <nadia@example.com>";

// The blobId get_email prints for the seeded contract, which is all a forward
// has to go on.
const CONTRACT_LINE_RE =
	/contract\.pdf — application\/pdf,[^\n]*blobId: (\S+)/u;
// The blobId get_draft prints for an attached file, which is the handle an
// update_draft that keeps that file has to pass back.
const DRAFT_BLOB_ID_RE = /blobId: (\S+)/u;
const UPLOAD_URL_RE = /'(http:\/\/\S+\/attachments\/uploads\/[\w-]+)'/u;
const BASE64_LINE_RE = /.{1,76}/gu;
const STDIO_ORIGIN_RE = /^http:\/\/127\.0\.0\.1:\d+$/u;

const RECEIVED_AT = new Date("2026-07-21T10:00:00Z");

const fixture = (name: string): Uint8Array<ArrayBuffer> =>
	new Uint8Array(
		readFileSync(
			new URL(`../src/attachments/fixtures/${name}`, import.meta.url)
		)
	);

// Base64 wrapped at 76 columns, as RFC 2045 §6.8 wants it inside MIME.
const base64Lines = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString("base64").match(BASE64_LINE_RE)?.join("\r\n") ??
	"";

// The message carrying the contract, as it would arrive from a correspondent.
const contractMime = (to: string, run: string | number): string =>
	[
		`From: ${CORRESPONDENT}`,
		`To: ${to}`,
		"Subject: Signed contract",
		`Message-ID: <contract-${run}@e2e.example.com>`,
		"Date: Tue, 21 Jul 2026 10:00:00 +0000",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="mixed-b"',
		"",
		"--mixed-b",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Countersigned copy attached.",
		"--mixed-b",
		'Content-Type: application/pdf; name="contract.pdf"',
		"Content-Transfer-Encoding: base64",
		'Content-Disposition: attachment; filename="contract.pdf"',
		"",
		base64Lines(fixture("sample.pdf")),
		"--mixed-b--",
		"",
	].join("\r\n");

live(
	"draft attachments against live Stalwart — attach, forward, edit, send",
	() => {
		const run = Date.now();
		let address: string;
		let authorization: string;
		let accountId: string;
		let apiUrl: string;
		let session: MailSession;
		let inboxId: string;
		let draftsId: string;
		let deps: DraftToolDeps;
		let getEmailDeps: GetEmailDeps;
		let runtime: ServerRuntime;
		let routes: { fetch: FetchHandler };
		let replays: IdempotencyStore<string>;
		let guard: SendGuard;
		// The contract that arrives by mail — the "forward that to the lawyer" case.
		let contractBytes: Uint8Array<ArrayBuffer>;
		let contractMessageId: string;
		// A file the agent generated itself — the motivating invoice case.
		let invoiceBytes: Uint8Array<ArrayBuffer>;
		let invoiceBase64: string;

		const ctx = () => ({ accountId, apiUrl, authorization });
		const toolCtx = { principal: "", token: "" };

		// The bytes Stalwart is actually holding for an attachment part. Every
		// "the file survived" assertion in this file goes through here, because a
		// part with the right name and size can still hold the wrong content.
		const attachedBytes = (
			blobId: string,
			name: string,
			type: string
		): Promise<Uint8Array> => blobBytes(session, blobId, name, type);

		// The one attachment part of a message, with its blob fetched.
		const soleAttachment = async (emailId: string): Promise<AttachedFile> => {
			const record = await emailComposeGet({
				...ctx(),
				id: emailId,
				maxBodyValueBytes: 10_000,
			});
			const parts = record?.attachments ?? [];
			expect(parts).toHaveLength(1);
			const part = parts[0];
			expect(part?.blobId).toBeTruthy();
			const name = part?.name ?? "";
			const type = part?.type ?? "";
			return {
				bytes: await attachedBytes(part?.blobId ?? "", name, type),
				name,
				size: part?.size ?? 0,
				type,
			};
		};

		// The draftId is a token the draft carries as a keyword; `emailId` is the
		// message it names right now.
		const stage = async (
			args: Record<string, unknown>
		): Promise<{ draftId: string; emailId: string; text: string }> => {
			const result = await createDraft(deps, replays, {
				...toolCtx,
				args: createDraftInput.parse(args),
			});
			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.text ?? "";
			const draftId = DRAFT_ID_RE.exec(text)?.[1] ?? "";
			return {
				draftId,
				emailId: (await draftIdResolve({ ...ctx(), draftId })) ?? "",
				text,
			};
		};

		beforeAll(async () => {
			const account = await createAccount({
				localPart: uniqueLocalPart("mcp-draft-att-e2e"),
			});
			address = account.address;
			authorization = account.authorization;
			session = await openMailSession(authorization);
			({ accountId, apiUrl } = session);

			// The runtime the HTTP transport builds, reached under a public URL:
			// its credential is the token every tool receives, signing in names
			// the principal, and its upload tickets are what the route redeems.
			const { config } = loadConfig(
				{
					MCP_AUTH_TOKEN: "an-e2e-token-nobody-presents",
					MCP_PUBLIC_URL: PUBLIC,
					STALWART_PASSWORD: account.secret,
					STALWART_URL: ADMIN_URL,
					STALWART_USERNAME: address,
				},
				["--http"]
			);
			runtime = createRuntime(config);
			await runtime.signIn();
			expect(runtime.getPrincipal()).toBe(address);
			toolCtx.principal = runtime.getPrincipal();
			toolCtx.token = runtime.getToken();
			replays = runtime.composeReplays;
			guard = runtime.sendGuard;
			// The real route handler behind the real guard, dispatched directly — no
			// listener needed.
			routes = {
				fetch: createFetchHandler(linkRoutes(runtime), {
					guard: createRequestGuard({ host: LOOPBACK, publicUrl: PUBLIC }),
				}),
			};

			inboxId =
				(await mailboxIdByRole({ ...ctx(), role: "inbox" })) ??
				(await mailboxCreate({ ...ctx(), name: "Inbox", role: "inbox" }));
			draftsId =
				(await mailboxIdByRole({ ...ctx(), role: "drafts" })) ??
				(await mailboxCreate({ ...ctx(), name: "Drafts", role: "drafts" }));

			// The same PDF fixture stands in for both files. They travel by completely
			// different routes — one arrives as MIME and is forwarded by handle, the
			// other is uploaded as base64 — so identical starting bytes make a
			// mismatch at the far end unambiguous.
			contractBytes = fixture("sample.pdf");
			invoiceBytes = contractBytes;
			invoiceBase64 = Buffer.from(invoiceBytes).toString("base64");
			contractMessageId = await importEmail(session, {
				raw: contractMime(address, run),
				receivedAt: RECEIVED_AT,
			});

			// The deps the server registers the tools with.
			deps = makeDraftDeps(runtime.jmapLive);
			getEmailDeps = makeGetEmailDeps(runtime.jmapLive);
		});

		afterAll(async () => {
			await destroyCreatedAccounts();
		});

		// --- acceptance criterion: generate a file, stage a draft carrying it ------

		test("create_draft stages a generated file as a real attachment, in one call", async () => {
			const { draftId, emailId, text } = await stage({
				attachments: [{ content: invoiceBase64, filename: "RE-2026-006.pdf" }],
				subject: "Corrected invoice",
				text: "The corrected invoice is attached.",
				to: [CORRESPONDENT],
			});
			expect(draftId).not.toBe("");
			// The tool told the agent what it staged, so the user can be told too.
			expect(text).toContain("attachments (1):");
			expect(text).toContain("RE-2026-006.pdf");

			// Stalwart filed it as an unsent draft…
			const record = await emailComposeGet({
				...ctx(),
				id: emailId,
				maxBodyValueBytes: 10_000,
			});
			expect(record?.keywords?.$draft).toBe(true);
			expect(record?.mailboxIds?.[draftsId]).toBe(true);
			expect(record?.hasAttachment).toBe(true);

			// …carrying a part whose name, media type, size, and bytes are all the
			// file the agent handed over. Size and bytes both, because a truncated or
			// re-encoded upload still has the right name.
			const attachment = await soleAttachment(emailId);
			expect(attachment.name).toBe("RE-2026-006.pdf");
			expect(attachment.type).toBe("application/pdf");
			expect(attachment.size).toBe(invoiceBytes.byteLength);
			expect(attachment.bytes).toEqual(invoiceBytes);
		});

		// --- acceptance criterion: re-attach by blobId, without downloading it -----

		test("an attachment already in the mailbox is forwarded by blobId alone", async () => {
			// Everything the agent has to go on is what get_email printed — the same
			// blobId a human-facing client would see. The bytes are never fetched.
			const read = await getEmail(getEmailDeps, {
				args: getEmailInput.parse({ id: contractMessageId }),
				token: toolCtx.token,
			});
			expect(read.isError).toBeUndefined();
			const contractBlobId =
				CONTRACT_LINE_RE.exec(read.content[0]?.text ?? "")?.[1] ?? "";
			expect(contractBlobId).not.toBe("");

			const { emailId } = await stage({
				attachments: [
					{
						blobId: contractBlobId,
						filename: "contract.pdf",
						mimeType: "application/pdf",
					},
				],
				subject: "Fwd: Signed contract",
				text: "Forwarding the countersigned copy.",
				to: ["lawyer@example.com"],
			});

			const attachment = await soleAttachment(emailId);
			expect(attachment.name).toBe("contract.pdf");
			expect(attachment.type).toBe("application/pdf");
			// The forwarded part is the file that arrived, byte for byte, having made
			// no round trip through this process.
			expect(attachment.bytes).toEqual(contractBytes);
		});

		// --- a local file, uploaded through the capability URL --------------------

		test("a file PUT to an upload URL attaches by the blobId the upload returns", async () => {
			// The route as the server wires it: a ticket of the runtime's store,
			// holding the account's credential, redeemed through the link routes.
			const { token } = runtime.uploadTickets.mint({
				accountId,
				authorization,
				// No extension to guess from: the media type survives only if the
				// entry the upload hands back carries it.
				filename: "Bescheid-2025",
				type: "application/pdf",
			});

			// Streamed in uneven chunks, the way curl -T sends a file from disk.
			const third = Math.ceil(invoiceBytes.byteLength / 3);
			const body = new ReadableStream<Uint8Array>({
				start: (controller) => {
					for (
						let offset = 0;
						offset < invoiceBytes.byteLength;
						offset += third
					) {
						controller.enqueue(invoiceBytes.slice(offset, offset + third));
					}
					controller.close();
				},
			});
			// The request a reverse proxy in front of the server would pass on: the
			// public URL's host, no Origin, no credential but the ticket.
			const res = await routes.fetch(
				new Request(`${PUBLIC}/attachments/uploads/${token}`, {
					body,
					duplex: "half",
					headers: { host: PUBLIC_HOST },
					method: "PUT",
				} as RequestInit)
			);
			expect(res.status).toBe(200);
			const uploaded = (await res.json()) as {
				blobId: string;
				filename: string;
				mimeType: string;
				size: number;
			};
			expect(uploaded.size).toBe(invoiceBytes.byteLength);

			// Attached with exactly the entry the upload response describes.
			const { draftId, emailId } = await stage({
				attachments: [
					{
						blobId: uploaded.blobId,
						filename: uploaded.filename,
						mimeType: uploaded.mimeType,
					},
				],
				subject: "Steuerbescheide",
				text: "The notice is attached.",
				to: [CORRESPONDENT],
			});

			// The person reviewing the draft sees the file before it is sent…
			const read = await getDraft(deps, {
				args: getDraftInput.parse({ draftId }),
				token: toolCtx.token,
			});
			expect(read.content[0]?.text).toContain(
				"Bescheid-2025 — application/pdf"
			);
			// …and it is the file that left the disk, byte for byte.
			const attachment = await soleAttachment(emailId);
			expect(attachment.name).toBe("Bescheid-2025");
			expect(attachment.type).toBe("application/pdf");
			expect(attachment.bytes).toEqual(invoiceBytes);
		});

		// --- acceptance criterion: get_draft shows what is attached ---------------

		test("get_draft reports the attached file and the blobId an edit would need", async () => {
			const { draftId } = await stage({
				attachments: [{ content: invoiceBase64, filename: "RE-2026-007.pdf" }],
				subject: "For review",
				text: "Please check the attached invoice.",
				to: [CORRESPONDENT],
			});

			const result = await getDraft(deps, {
				args: getDraftInput.parse({ draftId }),
				token: toolCtx.token,
			});
			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("Draft (not sent):");
			expect(text).toContain("attachments (1):");
			expect(text).toContain("RE-2026-007.pdf — application/pdf");
			// The blobId is the handle update_draft needs to keep this file, so it has
			// to be a real one Stalwart will accept — not a partId or a placeholder.
			const blobId = DRAFT_BLOB_ID_RE.exec(text)?.[1] ?? "";
			expect(blobId).not.toBe("");
			expect(
				await attachedBytes(blobId, "RE-2026-007.pdf", "application/pdf")
			).toEqual(invoiceBytes);
		});

		// --- editing an attached draft -------------------------------------------

		test("update_draft rewrites the message and keeps the file it never mentioned", async () => {
			const { draftId, emailId } = await stage({
				attachments: [{ content: invoiceBase64, filename: "RE-2026-008.pdf" }],
				subject: "Invoice",
				text: "Draft body.",
				to: [CORRESPONDENT],
			});

			const result = await updateDraft(deps, {
				args: updateDraftInput.parse({
					draftId,
					subject: "Invoice RE-2026-008 (corrected)",
				}),
				...toolCtx,
			});
			expect(result.isError).toBeUndefined();
			expect(DRAFT_ID_RE.exec(result.content[0]?.text ?? "")?.[1]).toBe(
				draftId
			);
			const updatedId = (await draftIdResolve({ ...ctx(), draftId })) ?? "";

			// The edit is create-then-destroy (RFC 8621 §4.6), so this is a different
			// message — behind the same draftId — that happens to reference the same
			// blob. Losing the file here would be unrecoverable — the original is
			// already gone.
			const inDrafts = await idsIn(session, draftsId);
			expect(inDrafts).toContain(updatedId);
			expect(updatedId).not.toBe(emailId);
			expect(inDrafts).not.toContain(emailId);

			const attachment = await soleAttachment(updatedId);
			expect(attachment.name).toBe("RE-2026-008.pdf");
			expect(attachment.bytes).toEqual(invoiceBytes);
		});

		test("update_draft replaces the whole attachment list when one is given", async () => {
			const { draftId } = await stage({
				attachments: [{ content: invoiceBase64, filename: "old.pdf" }],
				subject: "Swap the file",
				text: "Body.",
				to: [CORRESPONDENT],
			});

			const swapped = await updateDraft(deps, {
				args: updateDraftInput.parse({
					attachments: [
						{
							content: Buffer.from("replacement note").toString("base64"),
							filename: "note.txt",
						},
					],
					draftId,
				}),
				...toolCtx,
			});
			expect(swapped.isError).toBeUndefined();
			const swappedId = (await draftIdResolve({ ...ctx(), draftId })) ?? "";

			const attachment = await soleAttachment(swappedId);
			expect(attachment.name).toBe("note.txt");
			expect(attachment.type).toBe("text/plain");
			expect(Buffer.from(attachment.bytes).toString()).toBe("replacement note");

			// …and an empty list takes the file off entirely.
			const cleared = await updateDraft(deps, {
				args: updateDraftInput.parse({ attachments: [], draftId }),
				...toolCtx,
			});
			expect(cleared.isError).toBeUndefined();
			const clearedId = (await draftIdResolve({ ...ctx(), draftId })) ?? "";
			const record = await emailComposeGet({
				...ctx(),
				id: clearedId,
				maxBodyValueBytes: 10_000,
			});
			expect(record?.attachments ?? []).toHaveLength(0);
			expect(record?.hasAttachment ?? false).toBe(false);
		});

		// --- roundtrip through send_draft ----------------------------------------

		test("a staged attachment survives submission and arrives in the recipient’s Inbox", async () => {
			const before = await idsIn(session, inboxId);
			// Addressed to the account itself so delivery stays inside the server.
			const { draftId } = await stage({
				attachments: [{ content: invoiceBase64, filename: "RE-2026-009.pdf" }],
				subject: "Invoice for June",
				text: "Invoice attached.",
				to: [address],
			});

			const sent = await sendDraft(deps, replays, guard, {
				...toolCtx,
				args: sendDraftInput.parse({ draftId }),
			});
			expect(sent.isError).toBeUndefined();
			const sentText = sent.content[0]?.text ?? "";
			expect(sentText).toContain("Sent.");
			// The send report names the file, so "what went out" is answerable from the
			// one call that made it irreversible.
			expect(sentText).toContain("RE-2026-009.pdf");

			// The Sent copy — the user's own record — still holds the file.
			const messageId = MESSAGE_ID_RE.exec(sentText)?.[1] ?? "";
			const sentCopy = await soleAttachment(messageId);
			expect(sentCopy.bytes).toEqual(invoiceBytes);

			// The delivered copy is a different Email, assembled and transmitted by the
			// MTA. This is the assertion the feature actually lives or dies on.
			// Local delivery is asynchronous, so it is awaited, not assumed.
			const delivered = await awaitDelivery(session, inboxId, before);
			expect(delivered.length).toBeGreaterThan(0);
			const deliveredId = delivered[0] ?? "";
			const arrived = await soleAttachment(deliveredId);
			expect(arrived.name).toBe("RE-2026-009.pdf");
			expect(arrived.type).toBe("application/pdf");
			expect(arrived.bytes).toEqual(invoiceBytes);
		});

		// --- forward_message: one call, the original's file and thread -------------

		test("forward_message carries the original file into the recipient’s Inbox and threads with the original", async () => {
			const before = await idsIn(session, inboxId);
			const result = await forwardMessage(deps, replays, guard, {
				...toolCtx,
				args: forwardMessageInput.parse({
					messageId: contractMessageId,
					text: "For your records.",
					to: [address],
				}),
			});
			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("Forward sent.");
			expect(text).toContain("contract.pdf");
			expect(text).not.toContain("could not be marked");

			// The Sent copy holds the file, by the blob it was forwarded from, and
			// sits in the original's conversation.
			const messageId = MESSAGE_ID_RE.exec(text)?.[1] ?? "";
			expect((await soleAttachment(messageId)).bytes).toEqual(contractBytes);
			const sentCopy = await emailComposeGet({
				...ctx(),
				bodyValues: "body",
				id: messageId,
				maxBodyValueBytes: 10_000,
			});
			const original = await emailComposeGet({
				...ctx(),
				id: contractMessageId,
				maxBodyValueBytes: 1,
			});
			expect(sentCopy?.threadId).toBe(original?.threadId ?? "");
			expect(sentCopy?.subject).toBe("Fwd: Signed contract");
			expect(original?.keywords?.$forwarded).toBe(true);

			// And it arrives, file and forwarded header block included.
			const delivered = await awaitDelivery(session, inboxId, before);
			const arrivedId = delivered[0] ?? "";
			expect((await soleAttachment(arrivedId)).bytes).toEqual(contractBytes);
			const arrived = await emailComposeGet({
				...ctx(),
				bodyValues: "body",
				id: arrivedId,
				maxBodyValueBytes: 10_000,
			});
			const body = Object.values(arrived?.bodyValues ?? {})
				.map((value) => value.value)
				.join("\n");
			expect(body).toContain("For your records.");
			expect(body).toContain("---------- Forwarded message ---------");
			expect(body).toContain("Countersigned copy attached.");
		});

		test("a staged forward of a photo inline in the body keeps it through an edit of the note", async () => {
			const pixel = Buffer.from(fixture("pixel.png")).toString("base64");
			// The Apple Mail shape: text, an inline image, more text, in one multipart/mixed.
			const photoId = await importEmail(session, {
				raw: [
					`From: ${CORRESPONDENT}`,
					`To: ${address}`,
					"Subject: Photo of the meter",
					`Message-ID: <photo-${run}@e2e.example.com>`,
					"Date: Tue, 21 Jul 2026 11:00:00 +0000",
					"MIME-Version: 1.0",
					'Content-Type: multipart/mixed; boundary="m"',
					"",
					"--m",
					"Content-Type: text/plain; charset=utf-8",
					"",
					"Here is the meter:",
					"--m",
					'Content-Type: image/png; name="meter.png"',
					'Content-Disposition: inline; filename="meter.png"',
					"Content-Transfer-Encoding: base64",
					"",
					pixel,
					"--m",
					"Content-Type: text/plain; charset=utf-8",
					"",
					"Reading as of today.",
					"--m--",
					"",
				].join("\r\n"),
				receivedAt: RECEIVED_AT,
			});
			const images = (record: EmailComposeRecord | null): number =>
				attachmentsFromRecord(record ?? { id: "" }).filter(
					(file) => file.type === "image/png"
				).length;
			const { draftId, emailId } = await stage({
				forwardOf: photoId,
				to: ["caretaker@example.com"],
			});
			expect(
				images(
					await emailComposeGet({
						...ctx(),
						id: emailId,
						maxBodyValueBytes: 10_000,
					})
				)
			).toBe(1);

			const edited = await updateDraft(deps, {
				...toolCtx,
				args: updateDraftInput.parse({ draftId, text: "See below." }),
			});
			expect(edited.isError).toBeUndefined();
			const current = (await draftIdResolve({ ...ctx(), draftId })) ?? "";
			const revision = await emailComposeGet({
				...ctx(),
				id: current,
				maxBodyValueBytes: 10_000,
			});
			expect(images(revision)).toBe(1);
		});

		// --- refusals -------------------------------------------------------------

		test("an oversized attachment is refused up front, with nothing staged", async () => {
			const before = await idsIn(session, draftsId);
			const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024).toString(
				"base64"
			);
			const result = await createDraft(deps, replays, {
				...toolCtx,
				args: createDraftInput.parse({
					attachments: [{ content: oversized, filename: "huge.bin" }],
					subject: "Too big",
					text: "Body.",
					to: [CORRESPONDENT],
				}),
			});
			expect(result.isError).toBe(true);
			// Named number, and the refusal comes from us rather than from a submission
			// failure hours later.
			expect(result.content[0]?.text ?? "").toContain("25 MB");
			expect(await idsIn(session, draftsId)).toEqual(before);
		});

		test("an unknown blobId is refused by the server, and no draft is left behind", async () => {
			const before = await idsIn(session, draftsId);
			const result = await createDraft(deps, replays, {
				...toolCtx,
				args: createDraftInput.parse({
					attachments: [{ blobId: "Gnot-a-real-blob", filename: "ghost.pdf" }],
					subject: "Ghost file",
					text: "Body.",
					to: [CORRESPONDENT],
				}),
			});
			// Stalwart answers `blobNotFound` and names nothing further, so the tool
			// has to supply the diagnosis the agent can act on — a bare error code
			// would leave it with no next move.
			expect(result.isError).toBe(true);
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("blobId");
			expect(text).toContain("Nothing was staged");
			// And what must not happen: a draft staged that silently lost its file.
			expect(await idsIn(session, draftsId)).toEqual(before);
		});
	}
);

// --- the built server, as an agent runs it ---------------------------------

interface Mailbox {
	account: TestAccount;
	inbox: string;
	session: MailSession;
}

const openMailbox = async (name: string): Promise<Mailbox> => {
	const account = await createAccount({ localPart: uniqueLocalPart(name) });
	const session = await openMailSession(account.authorization);
	return { account, inbox: await mailboxId(session, "inbox"), session };
};

const idFrom = (text: string, pattern: RegExp): string => {
	const id = pattern.exec(text)?.[1];
	expect(id).toBeDefined();
	return id as string;
};

interface Started {
	call: ToolCaller;
	/** Where the server's file links must point. */
	linkOrigin: RegExp;
	stop: () => Promise<unknown>;
}

type Start = (account: TestAccount) => Promise<Started>;

const overStdio: Start = async (account) => {
	const server = await startStdioServer(account);
	return {
		call: toolCaller(server.client),
		linkOrigin: STDIO_ORIGIN_RE,
		stop: server.stop,
	};
};

const overHttp: Start = async (account) => {
	const server = await startHttpServer(account);
	return {
		call: toolCaller(server.client),
		linkOrigin: new RegExp(`^${server.baseUrl}$`, "u"),
		stop: server.stop,
	};
};

// A file's whole journey, with a server the agent started itself and a second
// account at the far end: the bytes that arrive are the bytes that set out.
const filesOverTheBuiltServer = (transport: string, start: Start): void => {
	live(`sending files with the built server over ${transport}`, () => {
		const run = `${transport}-${Date.now()}`;
		const pdfBytes = fixture("sample.pdf");
		let sender: Mailbox;
		let recipient: Mailbox;
		let server: Started;
		let call: ToolCaller;
		let contractMessageId: string;

		beforeAll(async () => {
			sender = await openMailbox(`draft-att-${transport}-from`);
			recipient = await openMailbox(`draft-att-${transport}-to`);
			contractMessageId = await importEmail(sender.session, {
				raw: contractMime(sender.account.address, run),
				receivedAt: RECEIVED_AT,
			});
			server = await start(sender.account);
			({ call } = server);
		});

		afterAll(async () => {
			await server?.stop();
			await destroyCreatedAccounts();
		});

		test("forward_message carries a received attachment to the other account byte for byte", async () => {
			const before = await idsIn(recipient.session, recipient.inbox);
			const forwarded = await call("forward_message", {
				messageId: contractMessageId,
				text: "For your records.",
				to: [recipient.account.address],
			});
			expect(forwarded.isError).toBe(false);
			expect(forwarded.text).toContain("Forward sent.");
			expect(forwarded.text).toContain("contract.pdf");

			const delivered = await awaitDelivery(
				recipient.session,
				recipient.inbox,
				before
			);
			expect(delivered).toHaveLength(1);
			const arrivedId = delivered[0] ?? "";
			const files = await attachmentsOf(recipient.session, arrivedId);
			expect(files).toHaveLength(1);
			expect(files[0]?.name).toBe("contract.pdf");
			expect(files[0]?.type).toBe("application/pdf");
			expect(files[0]?.size).toBe(pdfBytes.byteLength);
			expect(files[0]?.bytes).toEqual(pdfBytes);

			const arrived = await composeRecord(recipient.session, arrivedId);
			expect(arrived?.subject).toBe("Fwd: Signed contract");
			expect(arrived?.from?.map((from) => from.email)).toEqual([
				sender.account.address,
			]);
			const body = bodyOf(arrived);
			expect(body).toContain("For your records.");
			expect(body).toContain("---------- Forwarded message ---------");
			expect(body).toContain("Countersigned copy attached.");
		});

		test("upload_attachments, a PUT of the file, create_draft and send_draft: the other account receives the same bytes", async () => {
			const links = await call("upload_attachments", {
				files: [{ filename: "scan.pdf", sizeBytes: pdfBytes.byteLength }],
			});
			expect(links.isError).toBe(false);
			const url = UPLOAD_URL_RE.exec(links.text)?.[1] as string;
			expect(url).toBeDefined();
			expect(new URL(url).origin).toMatch(server.linkOrigin);

			// As `curl -T scan.pdf <url>` does: no Authorization header, the link
			// is the credential.
			const put = await fetch(url, { body: pdfBytes, method: "PUT" });
			expect(put.status).toBe(200);
			const uploaded = (await put.json()) as {
				blobId: string;
				filename: string;
				mimeType: string;
				size: number;
			};
			expect(uploaded.size).toBe(pdfBytes.byteLength);

			const subject = `Scan ${run}`;
			const staged = await call("create_draft", {
				attachments: [
					{
						blobId: uploaded.blobId,
						filename: uploaded.filename,
						mimeType: uploaded.mimeType,
					},
				],
				subject,
				text: "The scan is attached.",
				to: [recipient.account.address],
			});
			expect(staged.isError).toBe(false);
			expect(staged.text).toContain("attachments (1):");
			expect(staged.text).toContain("scan.pdf");
			const draftId = idFrom(staged.text, DRAFT_ID_RE);

			const read = await call("get_draft", { draftId });
			expect(read.text).toContain("scan.pdf — application/pdf");

			const sent = await call("send_draft", { draftId });
			expect(sent.isError).toBe(false);
			expect(sent.text).toContain("Sent.");
			expect(sent.text).toContain("scan.pdf");

			const [arrived, ...copies] = await awaitSubject(
				recipient.session,
				recipient.inbox,
				subject
			);
			expect(copies).toEqual([]);
			const files = await attachmentsOf(recipient.session, arrived?.id ?? "");
			expect(files).toHaveLength(1);
			expect(files[0]?.name).toBe("scan.pdf");
			expect(files[0]?.type).toBe("application/pdf");
			expect(files[0]?.size).toBe(pdfBytes.byteLength);
			expect(files[0]?.bytes).toEqual(pdfBytes);
		});

		test("update_draft keeps an uploaded file through an edit, and the edited message delivers it", async () => {
			const subject = `Generated ${run}`;
			const staged = await call("create_draft", {
				attachments: [
					{
						content: Buffer.from(pdfBytes).toString("base64"),
						filename: "generated.pdf",
					},
				],
				subject: `${subject} (draft)`,
				text: "First wording.",
				to: [recipient.account.address],
			});
			expect(staged.isError).toBe(false);
			const draftId = idFrom(staged.text, DRAFT_ID_RE);

			const revised = await call("update_draft", {
				draftId,
				subject,
				text: "Second wording.",
			});
			expect(revised.isError).toBe(false);
			expect(revised.text).toContain("generated.pdf");

			const sent = await call("send_draft", { draftId });
			expect(sent.isError).toBe(false);

			const [arrived] = await awaitSubject(
				recipient.session,
				recipient.inbox,
				subject
			);
			expect(bodyOf(arrived ?? null)).toContain("Second wording.");
			const files = await attachmentsOf(recipient.session, arrived?.id ?? "");
			expect(files).toHaveLength(1);
			expect(files[0]?.name).toBe("generated.pdf");
			expect(files[0]?.bytes).toEqual(pdfBytes);
		});
	});
};

filesOverTheBuiltServer("stdio", overStdio);
filesOverTheBuiltServer("http", overHttp);
