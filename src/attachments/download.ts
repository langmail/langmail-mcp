// Redeem an attachment ticket: fetch the blob from Stalwart with the
// ticket's stored bearer and stream it through. Routing lives in
// routes.ts; this file owns the response shaping.
//
// Logging deliberately carries only status/size — never tokens or
// filenames.

import { blobDownload, JmapError, type JmapLive } from "../jmap/index.ts";
import { logger } from "../logger.ts";

import type { TicketStore } from "./tickets.ts";

export type AttachmentDownload = (token: string) => Promise<Response>;

const CONTROL_QUOTE_RE = /[\p{Cc}"\\]/gu;
const NON_ASCII_RE = /[^ -~]/gu;
// RFC 5987 attr-char does NOT include !'()* — encodeURIComponent leaves
// those bare, so they get a second pass.
const RFC5987_EXTRA_RE = /[!'()*]/gu;

const rfc5987Encode = (value: string): string =>
	encodeURIComponent(value).replaceAll(
		RFC5987_EXTRA_RE,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);

// Build a header-safe content-disposition. Strip quotes/backslashes/control
// chars (header smuggling), then — because fetch header values are Latin-1
// ByteStrings and the Headers constructor throws on anything above U+00FF
// (an em dash or CJK filename would 500 the route) — send an ASCII fallback
// in filename= and the real UTF-8 name via RFC 6266/5987 filename*.
const contentDisposition = (name: string): string => {
	const cleaned = name.replaceAll(CONTROL_QUOTE_RE, "").trim() || "attachment";
	const ascii = cleaned.replaceAll(NON_ASCII_RE, "_").trim() || "attachment";
	return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987Encode(cleaned)}`;
};

const notFound = (): Response => new Response("not found\n", { status: 404 });

export const createAttachmentDownload = (
	live: JmapLive,
	tickets: TicketStore
): AttachmentDownload => {
	return async (token) => {
		// Unknown and expired tokens are indistinguishable on purpose.
		const ticket = tickets.lookup(token);
		if (!ticket) {
			return notFound();
		}
		let upstream: Response;
		try {
			const session = await live.getSession(ticket.authorization);
			upstream = await blobDownload({
				accountId: ticket.accountId,
				authorization: ticket.authorization,
				blobId: ticket.blobId,
				downloadUrl: session.downloadUrl,
				name: ticket.name,
				type: ticket.type,
			});
		} catch (err) {
			// E.g. the bound bearer expired before the ticket did — the agent
			// re-calls download_attachment or download_email for a fresh URL.
			const status = err instanceof JmapError ? err.status : 502;
			logger.warn({ status }, "attachment blob fetch failed");
			return new Response("upstream error\n", { status: 502 });
		}

		const headers = new Headers({
			"cache-control": "no-store",
			"content-disposition": contentDisposition(ticket.name),
			"content-type": upstream.headers.get("content-type") ?? ticket.type,
		});
		const contentLength = upstream.headers.get("content-length");
		if (contentLength) {
			headers.set("content-length", contentLength);
		}
		logger.info(
			{ size: contentLength ? Number(contentLength) : null, status: 200 },
			"attachment downloaded"
		);
		// Pass the upstream body through as a stream — never buffered.
		return new Response(upstream.body, { headers });
	};
};
