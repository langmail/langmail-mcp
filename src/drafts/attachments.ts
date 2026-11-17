// Attachment resolution for the composition tools: turn what a caller can
// name into the JMAP blobIds `Email/set` wants.
//
// Two ways to name a file, and the order matters because the first one is the
// one we want callers to reach for:
//
//   - `blobId` — a blob that is already on the server, which is what
//     search_emails/get_email hand back for every attachment they list.
//     Forwarding a contract to a lawyer moves no bytes at all: the handle is
//     re-referenced by a new message and the blob is never downloaded, never
//     re-uploaded, and never enters the conversation.
//   - `content` — base64 bytes, for a file the agent has just produced. These
//     do pass through the model's context, which is why the cap is small and
//     the tool descriptions say to prefer `blobId`.
//
// A file on the agent's own disk reaches the first form too: upload_attachments
// hands out a URL the agent PUTs the file to, and the upload answers with a
// blobId (attachments/upload.ts), so a 10 MB PDF never passes through the model.
//
// There is deliberately no `path`. The MCP server is a remote HTTP service
// (services/mcp/src/index.ts — there is no stdio transport), so the agent's
// filesystem and the server's are different machines and a path would either
// name nothing or, worse, name one of the server's own files. `unnamedEntry`
// says so in as many words rather than letting the call fail as a shrug, and
// names the upload tool as the remedy.
//
// Inline parts (`cid`) are not exposed here yet. @langmail/jmap models them
// (`DraftAttachment.cid`), so an HTML body referencing a generated chart is a
// schema addition rather than a redesign; nothing needs one today.

import { z } from "zod";

import type { BlobUploadParams, DraftAttachment } from "../jmap/index.ts";

// Ceiling on the bytes one call *uploads*, checked before anything is sent.
// 25 MB is what a receiving MTA typically accepts (and what Gmail's own
// attachment API documents), so the refusal lands here — where the message
// names the number and nothing has been staged — rather than at submission
// time, where the draft already exists and the error is Stalwart's.
//
// Deliberately not a whole-message ceiling: a `blobId` entry is not weighed,
// because its size is not in the request and finding it out would cost a
// lookup per attachment on the common, cheap path — forwarding a file that is
// already sitting on the server. Stalwart still enforces its own message size
// at submission, so an enormous forward is refused, just later and by it. The
// cap here exists to stop *this* process buffering and uploading bytes that
// could never be delivered, and for that the upload total is the right meter.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const MAX_ATTACHMENTS = 10;

const DEFAULT_MIME_TYPE = "application/octet-stream";

// Base64 as RFC 4648 §4 spells it, after whitespace has been stripped. Models
// wrap long base64 across lines, so the whitespace is expected; anything else
// outside the alphabet means the bytes are not what the caller thinks they are,
// and decoding leniently would attach a silently corrupted file.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/u;
const WHITESPACE_RE = /\s+/gu;
// The trailing '=' run, which is how many bytes the last quantum does *not*
// carry.
const PADDING_RE = /[=]*$/u;

const EXTENSION_RE = /\.([a-z0-9]+)$/iu;

// Media types for the artifacts an agent actually generates. Guessing from the
// extension is worth the table: `mimeType` is optional, and a PDF that arrives
// as application/octet-stream is one the recipient's client offers as an opaque
// download instead of previewing. Anything not listed falls back to
// octet-stream, which is correct-but-dull rather than wrong.
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
	csv: "text/csv",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	gif: "image/gif",
	html: "text/html",
	ics: "text/calendar",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	json: "application/json",
	md: "text/markdown",
	pdf: "application/pdf",
	png: "image/png",
	svg: "image/svg+xml",
	txt: "text/plain",
	webp: "image/webp",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	zip: "application/zip",
};

const attachmentEntrySchema = z.object({
	blobId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Attach a file already on the server, by the blobId search_emails, get_thread, get_email, or " +
				"get_draft listed for it, or the one an upload from upload_attachments returned. Nothing " +
				"passes through the conversation — this is how you forward an attachment and how you attach a " +
				"file from your disk. Prefer this over `content` whenever you can."
		),
	content: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Base64-encoded bytes of a small file you generated. The bytes pass through the conversation, so " +
				"for a file on disk use upload_attachments and pass the `blobId` it returns instead."
		),
	filename: z
		.string()
		.min(1)
		.max(255)
		.optional()
		.describe(
			'Name the recipient sees, e.g. "invoice-2026-006.pdf". Required with `blobId` — pass the filename ' +
				"listed beside it (or the one you uploaded it as), or the file arrives unnamed. Always worth " +
				"setting with `content` too."
		),
	mimeType: z
		.string()
		.min(3)
		.max(255)
		.optional()
		.describe(
			'Media type, e.g. "application/pdf". Guessed from the filename extension when omitted.'
		),
});

export type AttachmentEntry = z.infer<typeof attachmentEntrySchema>;

export const attachmentsSchema = z
	.array(attachmentEntrySchema)
	.max(MAX_ATTACHMENTS)
	.describe(
		`Files to attach, at most ${MAX_ATTACHMENTS}. Each entry names its file either by \`blobId\` (already in ` +
			"the mailbox, or uploaded with upload_attachments — nothing passes through the conversation) " +
			"or by base64 `content` (a small file you just generated); the `content` entries may come to at most " +
			`${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB between them. A file path cannot be used: this server runs ` +
			"elsewhere and cannot read your disk — upload a local file with upload_attachments instead."
	);

export interface AttachmentUploadDeps {
	blobUpload: (p: BlobUploadParams) => Promise<string>;
}

export interface AttachmentResolution {
	accountId: string;
	authorization: string;
	entries: AttachmentEntry[];
}

export const mimeTypeFor = (entry: AttachmentEntry): string => {
	if (entry.mimeType) {
		return entry.mimeType;
	}
	const extension = EXTENSION_RE.exec(entry.filename ?? "")?.[1]?.toLowerCase();
	return (
		(extension ? MIME_TYPES_BY_EXTENSION[extension] : undefined) ??
		DEFAULT_MIME_TYPE
	);
};

// How the caller referred to an entry, for error messages. The index alone
// ("attachment 2") is unhelpfully abstract when the agent passed three files.
const label = (entry: AttachmentEntry, index: number): string =>
	entry.filename ? `"${entry.filename}"` : `attachment ${index + 1}`;

const unnamedEntry = (index: number): string =>
	`Attachment ${index + 1} names no file. Give it either \`blobId\` (for a file already in the mailbox — ` +
	"the blobId that search_emails or get_email listed) or `content` (base64 bytes). A file path is not " +
	"accepted: this MCP server runs on a different machine from you and cannot read your filesystem, so " +
	"upload the file with upload_attachments and pass the `blobId` it returns.";

// Decode one base64 payload, or say why it isn't one. Whitespace is stripped
// first because a wrapped payload is the normal case, not a malformed one.
const cleanBase64 = (
	content: string,
	name: string
): { cleaned: string } | { error: string } => {
	const cleaned = content.replaceAll(WHITESPACE_RE, "");
	// Whitespace-only content survives the schema's `.min(1)` and then satisfies
	// every base64 check, because the empty string is valid base64 for zero bytes.
	// Left alone it would upload an empty blob and report a staged attachment, so
	// a generated file that came out empty would reach the recipient as an empty
	// one — the silent version of the failure the caller most needs told about.
	if (cleaned.length === 0) {
		return {
			error:
				`The \`content\` of ${name} is empty, so nothing was staged. The file has no bytes — check it was ` +
				"actually written before attaching it.",
		};
	}
	if (cleaned.length % 4 !== 0 || !BASE64_RE.test(cleaned)) {
		return {
			error:
				`The \`content\` of ${name} is not valid base64, so nothing was staged. Encode the file's raw bytes ` +
				"as base64 — not its text, and not a data: URL.",
		};
	}
	return { cleaned };
};

// What a validated base64 payload will weigh once decoded, computed from its
// length rather than by decoding it.
//
// This is what lets the size cap be enforced before `Buffer.from` runs. Every
// 4 characters carry 3 bytes, less one byte per '=' of padding — exact, not an
// estimate — so an oversized payload is refused without ever allocating the
// decoded copy of it. Decoding first to find out how big it is would let a
// caller who ignored the documented cap make us allocate the very thing the cap
// exists to refuse.
export const decodedByteLength = (cleaned: string): number => {
	const padding = PADDING_RE.exec(cleaned)?.[0].length ?? 0;
	return (cleaned.length / 4) * 3 - padding;
};

// Resolve every entry to a blobId, uploading the ones that arrived as bytes.
//
// The whole list is validated — and the combined size checked — before a single
// upload runs, so a call that names one good file and one 40 MB one leaves no
// orphaned blob behind and no half-attached draft.
export const resolveAttachments = async (
	deps: AttachmentUploadDeps,
	p: AttachmentResolution
): Promise<{ attachments: DraftAttachment[] } | { error: string }> => {
	const uploads: { bytes: Uint8Array; index: number; type: string }[] = [];
	const resolved: DraftAttachment[] = [];
	let totalBytes = 0;

	for (const [index, entry] of p.entries.entries()) {
		if (entry.blobId && entry.content) {
			return {
				error:
					`${label(entry, index)} gives both \`blobId\` and \`content\`, so it is ambiguous which file was ` +
					"meant and nothing was staged. Pass one or the other.",
			};
		}
		const type = mimeTypeFor(entry);
		if (entry.blobId) {
			// A blobId carries bytes and nothing else — no name, no media type. Those
			// live on the *part* of the message the blob was read from, and this call
			// has no way back to it, so an entry that omits `filename` would forward
			// the file as an unnamed application/octet-stream: the recipient gets an
			// opaque download of a document that had a perfectly good name one
			// message ago. Refusing costs the caller nothing, because whatever listed
			// the blobId (get_email, search_emails, get_draft) printed the filename on
			// the very same line — and naming it also settles the media type, which
			// `mimeTypeFor` reads off the extension.
			if (entry.filename === undefined) {
				return {
					error:
						`Attachment ${index + 1} gives a \`blobId\` but no \`filename\`, so nothing was staged. Pass the ` +
						"filename listed beside that blobId — without it the file would arrive unnamed, as an " +
						"unrecognised download.",
				};
			}
			resolved.push({ blobId: entry.blobId, name: entry.filename, type });
			continue;
		}
		if (!entry.content) {
			return { error: unnamedEntry(index) };
		}
		const base64 = cleanBase64(entry.content, label(entry, index));
		if ("error" in base64) {
			return base64;
		}
		// Weighed before it is decoded — see `decodedByteLength`.
		totalBytes += decodedByteLength(base64.cleaned);
		if (totalBytes > MAX_ATTACHMENT_BYTES) {
			return {
				error:
					`These attachments come to more than the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB of new files a ` +
					"message can carry, so nothing was staged. Send fewer or smaller files, attach one already in the " +
					"mailbox by `blobId` instead of re-uploading it, or link to the large one.",
			};
		}
		// Placeholder: the blobId lands here once the upload runs, so the resolved
		// list keeps the caller's ordering rather than putting uploads last.
		resolved.push({
			blobId: "",
			type,
			...(entry.filename === undefined ? {} : { name: entry.filename }),
		});
		// The Buffer is handed on as-is: it already *is* a Uint8Array, so wrapping
		// it in one would allocate and copy the whole payload a second time and
		// hold both until the uploads run — up to another 25 MB per request, on top
		// of the JSON and the cleaned base64 string already in memory.
		uploads.push({
			bytes: Buffer.from(base64.cleaned, "base64"),
			index: resolved.length - 1,
			type,
		});
	}

	for (const upload of uploads) {
		const blobId = await deps.blobUpload({
			accountId: p.accountId,
			authorization: p.authorization,
			content: upload.bytes,
			type: upload.type,
			uploadUrl: "",
		});
		const target = resolved[upload.index];
		if (target) {
			target.blobId = blobId;
		}
	}
	return { attachments: resolved };
};
