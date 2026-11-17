import { describe, expect, test } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

const AUTH_TOKEN = "a-long-random-secret";

const BASIC = {
	STALWART_PASSWORD: "app-password",
	STALWART_URL: "https://mail.example.com",
	STALWART_USERNAME: "user@example.com",
};

const problemsOf = (
	env: Record<string, string | undefined>,
	argv: string[] = []
): string[] => {
	try {
		loadConfig(env, argv);
	} catch (error) {
		if (error instanceof ConfigError) {
			return error.problems;
		}
		throw error;
	}
	throw new Error("expected the configuration to be refused");
};

describe("loadConfig", () => {
	test("an app password becomes a Basic credential, over stdio, with the opt-ins off", () => {
		expect(loadConfig(BASIC)).toEqual({
			config: {
				allowRemoteImages: false,
				allowUnsubscribePost: false,
				credential: `Basic ${Buffer.from("user@example.com:app-password").toString("base64")}`,
				stalwartUrl: "https://mail.example.com",
				transport: { kind: "stdio" },
			},
			warnings: [],
		});
	});

	test("a token becomes a Bearer credential", () => {
		const { config } = loadConfig({
			STALWART_TOKEN: "tok-123",
			STALWART_URL: "https://mail.example.com",
		});
		expect(config.credential).toBe("Bearer tok-123");
	});

	test("a password keeps its spaces and non-ASCII characters", () => {
		const { config } = loadConfig({ ...BASIC, STALWART_PASSWORD: " pä ss " });
		expect(
			Buffer.from(config.credential.slice("Basic ".length), "base64").toString(
				"utf8"
			)
		).toBe("user@example.com: pä ss ");
	});

	test("trailing slashes on the Stalwart URL are dropped, a path is kept", () => {
		expect(
			loadConfig({ ...BASIC, STALWART_URL: " https://mail.example.com// " })
				.config.stalwartUrl
		).toBe("https://mail.example.com");
		expect(
			loadConfig({ ...BASIC, STALWART_URL: "https://example.com/mail/" }).config
				.stalwartUrl
		).toBe("https://example.com/mail");
	});

	test("a variable set to nothing counts as unset", () => {
		const { config } = loadConfig({
			...BASIC,
			LANGMAIL_MCP_ALLOW_REMOTE_IMAGES: "",
			MCP_AUTH_TOKEN: "",
			MCP_PORT: "",
			MCP_TRANSPORT: "",
			STALWART_TOKEN: "",
		});
		expect(config.credential.startsWith("Basic ")).toBe(true);
		expect(config.transport).toEqual({ kind: "stdio" });
		expect(config.allowRemoteImages).toBe(false);
	});

	test("no Stalwart URL is refused — there is no default server", () => {
		expect(
			problemsOf({ STALWART_PASSWORD: "p", STALWART_USERNAME: "u" })
		).toEqual([
			"STALWART_URL is not set. Set it to the base URL of your Stalwart server, for example https://mail.example.com.",
		]);
	});

	test.each(["mail.example.com", "ftp://mail.example.com", "not a url"])(
		"a Stalwart URL that is not http(s) is refused: %s",
		(url) => {
			expect(problemsOf({ ...BASIC, STALWART_URL: url })).toEqual([
				"STALWART_URL must be an http:// or https:// URL, for example https://mail.example.com.",
			]);
		}
	);

	test("a Stalwart URL carrying credentials is refused without echoing them", () => {
		const problems = problemsOf({
			...BASIC,
			STALWART_URL: "https://user:hunter2@mail.example.com",
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("must not contain a username or password");
		expect(problems[0]).not.toContain("hunter2");
	});

	test("plain http is allowed, with a warning unless the host is this machine", () => {
		expect(
			loadConfig({ ...BASIC, STALWART_URL: "http://127.0.0.1:9090" }).warnings
		).toEqual([]);
		expect(
			loadConfig({ ...BASIC, STALWART_URL: "http://localhost:9090" }).warnings
		).toEqual([]);
		const { warnings } = loadConfig({
			...BASIC,
			STALWART_URL: "http://mail.example.com",
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("unencrypted");
	});

	test("exactly one way to sign in is required", () => {
		const url = { STALWART_URL: "https://mail.example.com" };
		expect(problemsOf(url)[0]).toContain("No credential is set");
		expect(problemsOf({ ...url, STALWART_USERNAME: "u" })[0]).toContain(
			"STALWART_USERNAME is set but STALWART_PASSWORD is not"
		);
		expect(problemsOf({ ...url, STALWART_PASSWORD: "p" })[0]).toContain(
			"STALWART_PASSWORD is set but STALWART_USERNAME is not"
		);
		for (const both of [
			{ ...BASIC, STALWART_TOKEN: "t" },
			{ ...url, STALWART_TOKEN: "t", STALWART_USERNAME: "u" },
			{ ...url, STALWART_PASSWORD: "p", STALWART_TOKEN: "t" },
		]) {
			expect(problemsOf(both)).toEqual([
				"Both STALWART_TOKEN and STALWART_USERNAME/STALWART_PASSWORD are set. Use one way to sign in: an app password (username and password) or a token.",
			]);
		}
	});

	test("a username with a colon cannot be sent as Basic", () => {
		expect(problemsOf({ ...BASIC, STALWART_USERNAME: "a:b" })[0]).toContain(
			"must not contain a colon"
		);
	});

	test("every problem is reported at once, and no secret is quoted", () => {
		let message = "";
		try {
			loadConfig(
				{
					MCP_TRANSPORT: "http",
					STALWART_PASSWORD: "hunter2-password",
					STALWART_TOKEN: "hunter2-token",
					STALWART_URL: "nope",
					STALWART_USERNAME: "user@example.com",
				},
				["--verbose"]
			);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("langmail-mcp: cannot start");
		expect(message).toContain("STALWART_URL must be");
		expect(message).toContain("Both STALWART_TOKEN and");
		expect(message).toContain('Unknown argument "--verbose"');
		expect(message).toContain("MCP_AUTH_TOKEN is not set");
		expect(message).not.toContain("hunter2");
	});

	describe("transport", () => {
		const HTTP = { ...BASIC, MCP_AUTH_TOKEN: AUTH_TOKEN };

		test("stdio is the default, and can be asked for by name", () => {
			expect(loadConfig(BASIC).config.transport).toEqual({ kind: "stdio" });
			expect(
				loadConfig({ ...BASIC, MCP_TRANSPORT: "stdio" }).config.transport
			).toEqual({ kind: "stdio" });
			expect(loadConfig(BASIC, ["--stdio"]).config.transport).toEqual({
				kind: "stdio",
			});
		});

		test("--http or MCP_TRANSPORT=http selects HTTP with its defaults", () => {
			const expected = {
				authToken: AUTH_TOKEN,
				host: "127.0.0.1",
				kind: "http",
				port: 8080,
				publicUrl: "http://127.0.0.1:8080",
			};
			expect(loadConfig(HTTP, ["--http"]).config.transport).toEqual(expected);
			expect(
				loadConfig({ ...HTTP, MCP_TRANSPORT: " HTTP " }).config.transport
			).toEqual(expected);
		});

		test("a flag wins over MCP_TRANSPORT", () => {
			expect(
				loadConfig({ ...BASIC, MCP_TRANSPORT: "http" }, ["--stdio"]).config
					.transport
			).toEqual({ kind: "stdio" });
		});

		test("host, port and public URL are read; the public URL loses its trailing slash", () => {
			expect(
				loadConfig({
					...HTTP,
					MCP_HOST: "0.0.0.0",
					MCP_PORT: "9000",
					MCP_PUBLIC_URL: "https://mcp.example.com/",
					MCP_TRANSPORT: "http",
				}).config.transport
			).toEqual({
				authToken: AUTH_TOKEN,
				host: "0.0.0.0",
				kind: "http",
				port: 9000,
				publicUrl: "https://mcp.example.com",
			});
			expect(
				loadConfig({ ...HTTP, MCP_HOST: "0.0.0.0", MCP_PORT: "9000" }, [
					"--http",
				]).config.transport
			).toMatchObject({ publicUrl: "http://0.0.0.0:9000" });
		});

		test("HTTP refuses to start without MCP_AUTH_TOKEN", () => {
			expect(problemsOf(BASIC, ["--http"])).toEqual([
				"MCP_AUTH_TOKEN is not set. The HTTP transport refuses to start without it: set it to a long random secret, which callers send as `Authorization: Bearer <secret>`.",
			]);
		});

		test.each([
			["15 characters", "123456789012345"],
			["one character", "#"],
		])("a token shorter than 16 characters is refused: %s", (_, token) => {
			const problems = problemsOf({ ...BASIC, MCP_AUTH_TOKEN: token }, [
				"--http",
			]);
			expect(problems).toEqual([
				"MCP_AUTH_TOKEN is too short: it must be at least 16 characters. `openssl rand -hex 32` makes one.",
			]);
			expect(problems.join("\n")).not.toContain(token);
		});

		test("a token of exactly 16 characters is accepted", () => {
			expect(
				loadConfig({ ...BASIC, MCP_AUTH_TOKEN: "1234567890123456" }, ["--http"])
					.config.transport
			).toMatchObject({ authToken: "1234567890123456" });
		});

		test.each([
			["a space inside", "a long random secret"],
			["a space at the end", "a-long-random-secret "],
			["a character outside ASCII", "a-long-random-s\u00e9cret"],
			["a line break", "a-long-random\nsecret"],
		])("a token no HTTP header can carry is refused: %s", (_, token) => {
			expect(
				problemsOf({ ...BASIC, MCP_AUTH_TOKEN: token }, ["--http"])
			).toEqual([
				"MCP_AUTH_TOKEN must consist of printable ASCII characters without spaces, because callers send it in an HTTP header. `openssl rand -hex 32` makes one.",
			]);
		});

		test.each(["127.0.0.1", "127.0.0.53", "localhost", "::1"])(
			"binding a loopback address warns about nothing: %s",
			(host) => {
				expect(
					loadConfig({ ...HTTP, MCP_HOST: host }, ["--http"]).warnings
				).toEqual([]);
			}
		);

		test.each(["0.0.0.0", "::", "192.0.2.10", "mcp.example.com"])(
			"binding any other address warns that TLS belongs in front: %s",
			(host) => {
				const { warnings } = loadConfig({ ...HTTP, MCP_HOST: host }, [
					"--http",
				]);
				expect(warnings).toEqual([
					`MCP_HOST is ${host}, so the server is reachable from other machines over plain HTTP, and the bearer token and your mail travel unencrypted. Put a reverse proxy that terminates TLS in front of it, and set MCP_PUBLIC_URL to the https:// address callers use.`,
				]);
				expect(warnings.join("\n")).not.toContain(AUTH_TOKEN);
			}
		);

		test("an IPv6 bind address is bracketed in the default public URL", () => {
			expect(
				loadConfig({ ...HTTP, MCP_HOST: "::1" }, ["--http"]).config.transport
			).toMatchObject({ host: "::1", publicUrl: "http://[::1]:8080" });
		});

		test("the HTTP settings are not required for stdio", () => {
			expect(
				loadConfig({ ...BASIC, MCP_PUBLIC_URL: "not a url" }).config.transport
			).toEqual({ kind: "stdio" });
		});

		test.each(["0", "65536", "80.5", "http", "-1"])(
			"a port that is not 1–65535 is refused: %s",
			(port) => {
				expect(problemsOf({ ...HTTP, MCP_PORT: port }, ["--http"])).toEqual([
					"MCP_PORT must be a port number between 1 and 65535.",
				]);
			}
		);

		test("an unknown transport or public URL is refused", () => {
			expect(problemsOf({ ...BASIC, MCP_TRANSPORT: "sse" })).toEqual([
				'MCP_TRANSPORT must be "stdio" or "http".',
			]);
			expect(
				problemsOf({ ...HTTP, MCP_PUBLIC_URL: "mcp.example.com" }, ["--http"])
			).toEqual([
				"MCP_PUBLIC_URL must be an http:// or https:// URL, for example https://mcp.example.com.",
			]);
		});
	});

	describe("opt-in flags", () => {
		test("are off unless set to 1 or true", () => {
			const on = loadConfig({
				...BASIC,
				LANGMAIL_MCP_ALLOW_REMOTE_IMAGES: "true",
				LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST: "1",
			}).config;
			expect(on.allowRemoteImages).toBe(true);
			expect(on.allowUnsubscribePost).toBe(true);

			const off = loadConfig({
				...BASIC,
				LANGMAIL_MCP_ALLOW_REMOTE_IMAGES: "0",
				LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST: "false",
			}).config;
			expect(off.allowRemoteImages).toBe(false);
			expect(off.allowUnsubscribePost).toBe(false);
		});

		test("each is independent of the other", () => {
			const { config } = loadConfig({
				...BASIC,
				LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST: "1",
			});
			expect(config.allowUnsubscribePost).toBe(true);
			expect(config.allowRemoteImages).toBe(false);
		});

		test("anything else is refused rather than guessed", () => {
			expect(
				problemsOf({ ...BASIC, LANGMAIL_MCP_ALLOW_REMOTE_IMAGES: "yes" })
			).toEqual([
				"LANGMAIL_MCP_ALLOW_REMOTE_IMAGES must be 1 (on) or 0 (off).",
			]);
		});
	});
});
