import { describe, expect, test, vi } from "vitest";
import { createFetchHandler } from "../http/routes.ts";
import type { JmapLive } from "../jmap/index.ts";
import { createAttachmentDownload } from "./download.ts";
import { attachmentRoutes } from "./routes.ts";
import { createTicketStore } from "./tickets.ts";
import { createAttachmentUpload } from "./upload.ts";
import { createUploadTicketStore } from "./upload-tickets.ts";

const STALWART = "https://mail.example.com";
const PUBLIC = "https://mcp.example.com";
const withFetch = <T>(
	impl: (url: string, init?: RequestInit) => Promise<Response>,
	fn: () => Promise<T>
): Promise<T> => {
	const original = globalThis.fetch;
	globalThis.fetch = impl as unknown as typeof fetch;
	return fn().finally(() => {
		globalThis.fetch = original;
	});
};

describe("GET /attachments/:token", () => {
	const live: JmapLive = {
		getSession: () =>
			Promise.resolve({
				apiUrl: `${STALWART}/jmap/`,
				downloadUrl: `${STALWART}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
				primaryAccounts: { "urn:ietf:params:jmap:mail": "acct" },
				uploadUrl: `${STALWART}/jmap/upload/{accountId}/`,
			}),
		resolveAccountId: () => Promise.resolve("acct"),
	};

	const makeAttachmentRoutes = () => {
		const tickets = createTicketStore();
		const uploadTickets = createUploadTicketStore();
		const routes = {
			fetch: createFetchHandler(
				attachmentRoutes(
					createAttachmentDownload(live, tickets),
					createAttachmentUpload(live, uploadTickets)
				)
			),
		};
		return { routes, tickets };
	};

	test("streams the Stalwart blob through with download headers, no bearer required", async () => {
		const { routes, tickets } = makeAttachmentRoutes();
		const token = tickets.mint({
			accountId: "acct",
			authorization: "Bearer stalwart-tok",
			blobId: "Gd41d8cd",
			name: "invoice.pdf",
			type: "application/pdf",
		});
		const pdf = "%PDF-1.4 fake";
		const f = vi.fn((url: string, init?: RequestInit) => {
			// The stored bearer (not any client credential) is forwarded upstream.
			expect(url).toBe(
				`${STALWART}/jmap/download/acct/Gd41d8cd/invoice.pdf?accept=application%2Fpdf`
			);
			expect((init?.headers as Record<string, string>)?.authorization).toBe(
				"Bearer stalwart-tok"
			);
			return Promise.resolve(
				new Response(pdf, {
					headers: {
						"content-length": String(pdf.length),
						"content-type": "application/pdf",
					},
					status: 200,
				})
			);
		});
		const res = await withFetch(f, () =>
			routes.fetch(new Request(`${PUBLIC}/attachments/${token}`))
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/pdf");
		expect(res.headers.get("content-disposition")).toBe(
			"attachment; filename=\"invoice.pdf\"; filename*=UTF-8''invoice.pdf"
		);
		expect(res.headers.get("content-length")).toBe(String(pdf.length));
		expect(await res.text()).toBe(pdf);
	});

	test("sanitizes hostile filenames in content-disposition", async () => {
		const { routes, tickets } = makeAttachmentRoutes();
		const token = tickets.mint({
			accountId: "acct",
			authorization: "Bearer t",
			blobId: "b1",
			name: 'evil"\r\nx-injected: 1.pdf',
			type: "application/pdf",
		});
		const f = vi.fn(() => Promise.resolve(new Response("x", { status: 200 })));
		const res = await withFetch(f, () =>
			routes.fetch(new Request(`${PUBLIC}/attachments/${token}`))
		);
		expect(res.headers.get("content-disposition")).toBe(
			"attachment; filename=\"evilx-injected: 1.pdf\"; filename*=UTF-8''evilx-injected%3A%201.pdf"
		);
	});

	test("non-Latin-1 filenames get an ASCII fallback plus RFC 5987 filename* (no 500)", async () => {
		const { routes, tickets } = makeAttachmentRoutes();
		const token = tickets.mint({
			accountId: "acct",
			authorization: "Bearer t",
			blobId: "b1",
			// Em dash + umlaut + CJK — fetch header values are Latin-1 ByteStrings,
			// so the raw name in filename= would make the Headers constructor throw.
			name: "Rechnung — Büro 請求書.pdf",
			type: "application/pdf",
		});
		const f = vi.fn(() => Promise.resolve(new Response("x", { status: 200 })));
		const res = await withFetch(f, () =>
			routes.fetch(new Request(`${PUBLIC}/attachments/${token}`))
		);
		expect(res.status).toBe(200);
		const disposition = res.headers.get("content-disposition") ?? "";
		expect(disposition).toContain('filename="Rechnung _ B_ro ___.pdf"');
		expect(disposition).toContain(
			"filename*=UTF-8''Rechnung%20%E2%80%94%20B%C3%BCro%20%E8%AB%8B%E6%B1%82%E6%9B%B8.pdf"
		);
	});

	test("unknown or tampered tokens return a plain 404 without touching Stalwart", async () => {
		const { routes } = makeAttachmentRoutes();
		const f = vi.fn(() => {
			throw new Error("must not reach upstream");
		});
		const res = await withFetch(f, () =>
			routes.fetch(new Request(`${PUBLIC}/attachments/garbage`))
		);
		expect(res.status).toBe(404);
		expect(f).not.toHaveBeenCalled();
	});

	test("non-GET methods and nested paths are 404", async () => {
		const { routes, tickets } = makeAttachmentRoutes();
		const token = tickets.mint({
			accountId: "acct",
			authorization: "Bearer t",
			blobId: "b1",
			name: "x.pdf",
			type: "application/pdf",
		});
		expect(
			(
				await routes.fetch(
					new Request(`${PUBLIC}/attachments/${token}`, { method: "POST" })
				)
			).status
		).toBe(404);
		expect(
			(await routes.fetch(new Request(`${PUBLIC}/attachments/${token}/extra`)))
				.status
		).toBe(404);
		expect(
			(await routes.fetch(new Request(`${PUBLIC}/attachments/`))).status
		).toBe(404);
	});

	test("an upstream failure surfaces as 502, never the bearer", async () => {
		const { routes, tickets } = makeAttachmentRoutes();
		const token = tickets.mint({
			accountId: "acct",
			authorization: "Bearer expired",
			blobId: "b1",
			name: "x.pdf",
			type: "application/pdf",
		});
		const f = vi.fn(() =>
			Promise.resolve(new Response("unauthorized", { status: 401 }))
		);
		const res = await withFetch(f, () =>
			routes.fetch(new Request(`${PUBLIC}/attachments/${token}`))
		);
		expect(res.status).toBe(502);
		expect(await res.text()).not.toContain("expired");
	});
});

describe("PUT /attachments/uploads/:token", () => {
	const live: JmapLive = {
		getSession: () =>
			Promise.resolve({
				apiUrl: `${STALWART}/jmap/`,
				downloadUrl: `${STALWART}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
				primaryAccounts: { "urn:ietf:params:jmap:mail": "acct" },
				uploadUrl: `${STALWART}/jmap/upload/{accountId}/`,
			}),
		resolveAccountId: () => Promise.resolve("acct"),
	};

	const makeUploadRoutes = () => {
		const tickets = createTicketStore();
		const uploadTickets = createUploadTicketStore();
		const routes = {
			fetch: createFetchHandler(
				attachmentRoutes(
					createAttachmentDownload(live, tickets),
					createAttachmentUpload(live, uploadTickets)
				)
			),
		};
		const { token } = uploadTickets.mint({
			accountId: "acct",
			authorization: "Bearer stalwart-tok",
			filename: "scan.pdf",
			type: "application/pdf",
		});
		return { routes, token };
	};

	test("a PUT reaches the upload, no bearer required", async () => {
		const { routes, token } = makeUploadRoutes();
		const f = vi.fn(() =>
			Promise.resolve(
				new Response(JSON.stringify({ blobId: "Gb" }), { status: 200 })
			)
		);
		const res = await withFetch(f, () =>
			routes.fetch(
				new Request(`${PUBLIC}/attachments/uploads/${token}`, {
					body: "pdf",
					method: "PUT",
				})
			)
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { blobId: string }).blobId).toBe("Gb");
	});

	test("other methods, nested paths and the bare prefix are 404 and never spend the ticket", async () => {
		const { routes, token } = makeUploadRoutes();
		const f = vi.fn(() =>
			Promise.resolve(
				new Response(JSON.stringify({ blobId: "Gb" }), { status: 200 })
			)
		);
		await withFetch(f, async () => {
			expect(
				(
					await routes.fetch(
						new Request(`${PUBLIC}/attachments/uploads/${token}`)
					)
				).status
			).toBe(404);
			expect(
				(
					await routes.fetch(
						new Request(`${PUBLIC}/attachments/uploads/${token}`, {
							body: "x",
							method: "POST",
						})
					)
				).status
			).toBe(404);
			expect(
				(
					await routes.fetch(
						new Request(`${PUBLIC}/attachments/uploads/${token}/x`, {
							body: "x",
							method: "PUT",
						})
					)
				).status
			).toBe(404);
			expect(
				(
					await routes.fetch(
						new Request(`${PUBLIC}/attachments/uploads/`, {
							body: "x",
							method: "PUT",
						})
					)
				).status
			).toBe(404);
			// An upload token is not a download token.
			expect(
				(await routes.fetch(new Request(`${PUBLIC}/attachments/${token}`)))
					.status
			).toBe(404);
			const res = await routes.fetch(
				new Request(`${PUBLIC}/attachments/uploads/${token}`, {
					body: "x",
					method: "PUT",
				})
			);
			expect(res.status).toBe(200);
		});
		expect(f).toHaveBeenCalledTimes(1);
	});
});
