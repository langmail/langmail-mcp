import { afterEach, describe, expect, test, vi } from "vitest";
import { logger } from "../logger.ts";
import { createFetchHandler, healthRoute, type Route } from "./routes.ts";

const BASE = "http://127.0.0.1:8080";

afterEach(() => {
	vi.restoreAllMocks();
});

const text = (body: string, status = 200): Response =>
	new Response(body, { status });

// Spies on the shared logger and returns the request lines one call produced.
const requestLines = async (
	fn: () => Promise<unknown>
): Promise<Record<string, unknown>[]> => {
	const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
	await fn();
	return info.mock.calls
		.filter(([, msg]) => msg === "mcp request")
		.map(([fields]) => fields as unknown as Record<string, unknown>);
};

describe("createFetchHandler", () => {
	test("GET /healthz returns 200 ok and nothing about the server", async () => {
		const fetch = createFetchHandler([healthRoute]);
		const res = await fetch(new Request(`${BASE}/healthz`));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok\n");
		expect([...res.headers.keys()]).toEqual(["content-type"]);
	});

	test("a path no route serves is a plain 404", async () => {
		const fetch = createFetchHandler([healthRoute]);
		for (const path of [
			"/nope",
			"/",
			"/healthz/",
			"/healthzz",
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-authorization-server",
			"/readyz",
		]) {
			const res = await fetch(new Request(`${BASE}${path}`));
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("not found\n");
		}
	});

	test("a listener with no routes answers 404 to everything", async () => {
		const res = await createFetchHandler([])(new Request(`${BASE}/healthz`));
		expect(res.status).toBe(404);
	});

	test("a path without a trailing slash serves exactly that path", async () => {
		const fetch = createFetchHandler([
			{ handle: () => text("exact"), path: "/thing" },
		]);
		expect((await fetch(new Request(`${BASE}/thing`))).status).toBe(200);
		expect((await fetch(new Request(`${BASE}/thing?x=1`))).status).toBe(200);
		expect((await fetch(new Request(`${BASE}/thing/`))).status).toBe(404);
		expect((await fetch(new Request(`${BASE}/thing/below`))).status).toBe(404);
		expect((await fetch(new Request(`${BASE}/thingy`))).status).toBe(404);
	});

	test("a path with a trailing slash serves everything below it, and gets the URL", async () => {
		const seen: string[] = [];
		const fetch = createFetchHandler([
			{
				handle: (req, url) => {
					seen.push(`${req.method} ${url.pathname.slice("/files/".length)}`);
					return text("below");
				},
				path: "/files/",
			},
		]);
		await fetch(new Request(`${BASE}/files/abc`));
		await fetch(new Request(`${BASE}/files/uploads/def`, { method: "PUT" }));
		expect(seen).toEqual(["GET abc", "PUT uploads/def"]);
		expect((await fetch(new Request(`${BASE}/files`))).status).toBe(404);
	});

	test("the first matching route answers", async () => {
		const fetch = createFetchHandler([
			{ handle: () => text("first"), path: "/a/" },
			{ handle: () => text("second"), path: "/a/b" },
		]);
		expect(await (await fetch(new Request(`${BASE}/a/b`))).text()).toBe(
			"first"
		);
	});

	test("a guard's refusal is the answer, and no route runs", async () => {
		const handle = vi.fn(() => text("served"));
		const fetch = createFetchHandler([{ handle, path: "/thing" }], {
			guard: (req) =>
				req.headers.has("x-refuse") ? text("refused", 403) : undefined,
		});
		const refused = await fetch(
			new Request(`${BASE}/thing`, { headers: { "x-refuse": "1" } })
		);
		expect(refused.status).toBe(403);
		expect(handle).not.toHaveBeenCalled();
		// Refused ahead of routing: an unknown path is not told apart.
		expect(
			(
				await fetch(
					new Request(`${BASE}/nope`, { headers: { "x-refuse": "1" } })
				)
			).status
		).toBe(403);
		expect((await fetch(new Request(`${BASE}/thing`))).status).toBe(200);
	});

	test("a route that throws is answered with a bare 500 and logged without the message's secrets", async () => {
		const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
		const fetch = createFetchHandler([
			{
				handle: () => {
					throw new Error("upstream said no to Bearer abc.def.ghi");
				},
				path: "/boom",
			},
			{
				handle: () => Promise.reject(new Error("async failure")),
				path: "/boom-async",
			},
		]);
		for (const path of ["/boom", "/boom-async"]) {
			const res = await fetch(new Request(`${BASE}${path}`));
			expect(res.status).toBe(500);
			expect(await res.text()).toBe('{"error":"internal_error"}\n');
		}
		expect(error).toHaveBeenCalledTimes(2);
		expect(error.mock.calls[0]?.[1]).toBe("http unhandled request error");
		expect(JSON.stringify(error.mock.calls)).not.toContain("abc.def.ghi");
	});
});

describe("request logging", () => {
	const routes: Route[] = [
		healthRoute,
		{ handle: () => text("fine"), logAs: "/logged", path: "/logged" },
		{ handle: () => text("no", 401), logAs: "/logged", path: "/logged/" },
		{ handle: () => text("secret"), path: "/tickets/" },
	];

	test("records method, route, status and duration for a route with a log name", async () => {
		const lines = await requestLines(() =>
			createFetchHandler(routes)(
				new Request(`${BASE}/logged?who=alice@example.com`, {
					headers: { authorization: "Bearer the-token" },
					method: "POST",
				})
			)
		);
		expect(lines).toHaveLength(1);
		const [line] = lines;
		expect(line?.method).toBe("POST");
		expect(line?.route).toBe("/logged");
		expect(line?.status).toBe(200);
		expect(typeof line?.durationMs).toBe("number");
		expect(Object.keys(line ?? {}).sort()).toEqual([
			"durationMs",
			"method",
			"route",
			"status",
		]);
		// Neither the credential nor anything from the URL reaches the line.
		expect(JSON.stringify(line)).not.toContain("the-token");
		expect(JSON.stringify(line)).not.toContain("alice");
	});

	test("records a rejected request too — a 401 is an outcome, not a non-event", async () => {
		const lines = await requestLines(() =>
			createFetchHandler(routes)(new Request(`${BASE}/logged/anything/below`))
		);
		expect(lines[0]?.status).toBe(401);
		// The route's name, not the path that was sent.
		expect(lines[0]?.route).toBe("/logged");
	});

	test("records a 500 from a route that threw", async () => {
		vi.spyOn(logger, "error").mockImplementation(() => undefined);
		const lines = await requestLines(() =>
			createFetchHandler([
				{
					handle: () => {
						throw new Error("boom");
					},
					logAs: "/boom",
					path: "/boom",
				},
			])(new Request(`${BASE}/boom`))
		);
		expect(lines[0]?.status).toBe(500);
	});

	test("leaves health, unknown paths and routes without a log name unlogged", async () => {
		const fetch = createFetchHandler(routes);
		const lines = await requestLines(async () => {
			await fetch(new Request(`${BASE}/healthz`));
			await fetch(new Request(`${BASE}/.well-known/oauth-protected-resource`));
			await fetch(new Request(`${BASE}/tickets/an-unguessable-token`));
		});
		expect(lines).toHaveLength(0);
	});
});
