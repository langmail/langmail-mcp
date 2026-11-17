import { afterEach, describe, expect, test, vi } from "vitest";
import { logger } from "../logger.ts";
import { createRequestGuard } from "./guard.ts";
import { isLoopbackHost, urlHostname } from "./hosts.ts";

const request = (headers: Record<string, string>): Request =>
	new Request("http://localhost/mcp", { headers, method: "POST" });

afterEach(() => {
	vi.restoreAllMocks();
});

const quiet = (): ReturnType<typeof vi.spyOn> =>
	vi.spyOn(logger, "warn").mockImplementation(() => undefined);

describe("isLoopbackHost / urlHostname", () => {
	test.each([
		"127.0.0.1",
		"127.1.2.3",
		"localhost",
		"LOCALHOST",
		"::1",
		"[::1]",
	])("%s is loopback", (host) => {
		expect(isLoopbackHost(host)).toBe(true);
	});

	test.each([
		"0.0.0.0",
		"::",
		"192.0.2.1",
		"mcp.example.com",
		"127.0.0.1.example.com",
		"",
	])("%s is not loopback", (host) => {
		expect(isLoopbackHost(host)).toBe(false);
	});

	test("an IPv6 address is bracketed, anything else is left alone", () => {
		expect(urlHostname("::1")).toBe("[::1]");
		expect(urlHostname("[::1]")).toBe("[::1]");
		expect(urlHostname("127.0.0.1")).toBe("127.0.0.1");
		expect(urlHostname("mcp.example.com")).toBe("mcp.example.com");
	});
});

describe("createRequestGuard, bound to loopback", () => {
	const guard = createRequestGuard({
		host: "127.0.0.1",
		publicUrl: "http://127.0.0.1:8080",
	});

	test.each(["127.0.0.1:8080", "localhost:8080", "localhost", "[::1]:8080"])(
		"a loopback Host passes: %s",
		(host) => {
			expect(guard(request({ host }))).toBeUndefined();
		}
	);

	test.each([
		["a rebound hostname", "attacker.example.com:8080"],
		["a hostname that only starts like loopback", "127.0.0.1.example.com"],
		["another address of this machine", "192.0.2.10:8080"],
	])("a Host that is not loopback is refused: %s", async (_, host) => {
		const warn = quiet();
		const res = guard(request({ host }));
		expect(res?.status).toBe(403);
		expect(await res?.text()).toBe('{"error":"forbidden"}\n');
		// The reason is logged; the header a page chose is not.
		expect(warn).toHaveBeenCalledWith(
			{ reason: "invalid_host" },
			"http request refused"
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(host);
	});

	test("a request without a Host header is refused", () => {
		quiet();
		expect(guard(request({}))?.status).toBe(403);
	});

	test("a request without an Origin passes: clients that are not browsers send none", () => {
		expect(guard(request({ host: "127.0.0.1:8080" }))).toBeUndefined();
	});

	test.each([
		"http://localhost:3000",
		"http://127.0.0.1:8080",
		"http://[::1]:5173",
	])("a loopback Origin passes: %s", (origin) => {
		expect(guard(request({ host: "127.0.0.1:8080", origin }))).toBeUndefined();
	});

	test.each([
		["a website", "https://attacker.example.com"],
		["the opaque origin", "null"],
		["not a URL", "localhost"],
	])("a foreign Origin is refused: %s", (_, origin) => {
		const warn = quiet();
		const res = guard(request({ host: "127.0.0.1:8080", origin }));
		expect(res?.status).toBe(403);
		expect(res?.headers.get("access-control-allow-origin")).toBeNull();
		expect(JSON.stringify(warn.mock.calls)).not.toContain("attacker");
	});

	test("the public URL's hostname is accepted as Host and Origin", () => {
		const proxied = createRequestGuard({
			host: "127.0.0.1",
			publicUrl: "https://mcp.example.com",
		});
		expect(
			proxied(
				request({ host: "mcp.example.com", origin: "https://mcp.example.com" })
			)
		).toBeUndefined();
		quiet();
		expect(proxied(request({ host: "other.example.com" }))?.status).toBe(403);
	});
});

describe("createRequestGuard, bound to another address", () => {
	const guard = createRequestGuard({
		host: "0.0.0.0",
		publicUrl: "https://mcp.example.com",
	});

	test("Host is not checked: the listener is reached under names it cannot know", () => {
		expect(guard(request({ host: "192.0.2.10:8080" }))).toBeUndefined();
		expect(guard(request({ host: "internal-name:8080" }))).toBeUndefined();
	});

	test("a foreign Origin is still refused", () => {
		quiet();
		expect(
			guard(
				request({
					host: "192.0.2.10:8080",
					origin: "https://attacker.example.com",
				})
			)?.status
		).toBe(403);
	});

	test("the public URL's own origin passes", () => {
		expect(
			guard(
				request({ host: "mcp.example.com", origin: "https://mcp.example.com" })
			)
		).toBeUndefined();
	});

	test("a specific bind address is one of the listener's own names", () => {
		const bound = createRequestGuard({ host: "192.0.2.10" });
		expect(
			bound(
				request({ host: "192.0.2.10:8080", origin: "http://192.0.2.10:8080" })
			)
		).toBeUndefined();
	});
});
