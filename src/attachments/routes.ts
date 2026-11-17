// The routes that redeem attachment tickets: `GET /attachments/<ticket>`
// streams a file out, `PUT /attachments/uploads/<ticket>` takes one in.
//
// Neither asks for the bearer token: the unguessable ticket in the path is
// the credential, the same model as a presigned URL. That is what lets the
// agent move a file with plain `curl`, so its bytes never pass through the
// conversation.

import type { Route } from "../http/routes.ts";
import type { AttachmentDownload } from "./download.ts";
import type { AttachmentUpload } from "./upload.ts";

const ATTACHMENTS_PREFIX = "/attachments/";
const UPLOADS_PREFIX = "/attachments/uploads/";
const HTTP_NOT_FOUND = 404;

const notFound = (): Response =>
	new Response("not found\n", { status: HTTP_NOT_FOUND });

// Anything but a clean GET (download) or PUT (upload) of a single token
// segment is a plain 404 — indistinguishable from an unknown/expired token,
// on purpose.
const attachmentsRoute = (
	req: Request,
	pathname: string,
	download: AttachmentDownload,
	upload: AttachmentUpload
): Response | Promise<Response> => {
	// Both under /attachments/, so one rule in a reverse proxy keeps every
	// ticket out of its access log. A download token is base64url and so never
	// contains a slash, which keeps the two shapes apart.
	if (pathname.startsWith(UPLOADS_PREFIX)) {
		const uploadToken = pathname.slice(UPLOADS_PREFIX.length);
		if (req.method === "PUT" && uploadToken && !uploadToken.includes("/")) {
			return upload(uploadToken, req);
		}
		return notFound();
	}
	const token = pathname.slice(ATTACHMENTS_PREFIX.length);
	if (req.method === "GET" && token && !token.includes("/")) {
		return download(token);
	}
	return notFound();
};

/**
 * The attachment routes for a listener. No `logAs`: the path is the
 * credential, and the download and upload handlers log their own line (status
 * and size only).
 */
export const attachmentRoutes = (
	download: AttachmentDownload,
	upload: AttachmentUpload
): Route[] => [
	{
		handle: (req, url) => attachmentsRoute(req, url.pathname, download, upload),
		path: ATTACHMENTS_PREFIX,
	},
];
