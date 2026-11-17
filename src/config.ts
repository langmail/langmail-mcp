// Reads and validates the server's configuration from the environment and the
// command line. Everything is checked up front, and a misconfigured server
// refuses to start with a message that says what to set.
//
// Nothing here has a default that points anywhere: the Stalwart URL and the
// credential are always the user's own.

import { z } from "zod";
import { isLoopbackHost, urlHostname } from "./http/hosts.ts";

const TRAILING_SLASHES_RE = /\/+$/u;
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 8080;
const MAX_PORT = 65_535;
// Short enough to type by hand is short enough to guess.
const MIN_AUTH_TOKEN_LENGTH = 16;
// What an `Authorization: Bearer` header can carry as one token: visible
// ASCII, no spaces.
const AUTH_TOKEN_RE = /^[\x21-\x7e]+$/u;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
	"localhost",
	"127.0.0.1",
	"[::1]",
]);

export interface StdioTransportConfig {
	kind: "stdio";
}

export interface HttpTransportConfig {
	// Callers must send `Authorization: Bearer <authToken>`.
	authToken: string;
	host: string;
	kind: "http";
	port: number;
	// The base URL links handed to the agent are minted under, without a
	// trailing slash.
	publicUrl: string;
}

export interface Config {
	// Opt-in: preview_email may fetch a message's remote images through the
	// server. Off by default — it is traffic to hosts the sender chose.
	allowRemoteImages: boolean;
	// Opt-in: unsubscribe_from_list may send the RFC 8058 one-click POST to the
	// sender's URL. Off by default, for the same reason.
	allowUnsubscribePost: boolean;
	// The complete `Authorization` header value sent to Stalwart:
	// `Basic <base64(username:password)>` or `Bearer <token>`. It is what every
	// tool receives as its "token".
	credential: string;
	// Base URL of the user's Stalwart (JMAP and CalDAV), without a trailing
	// slash.
	stalwartUrl: string;
	transport: StdioTransportConfig | HttpTransportConfig;
}

export interface LoadedConfig {
	config: Config;
	// Things worth telling the user that do not stop the server.
	warnings: string[];
}

/** A misconfiguration. `message` is ready to print: it names what to set and never quotes a secret. */
export class ConfigError extends Error {
	problems: string[];
	constructor(problems: string[]) {
		super(
			[
				"langmail-mcp: cannot start, the configuration is not usable:",
				...problems.map((problem) => `  - ${problem}`),
				"See .env.example in the langmail-mcp repository for every setting.",
			].join("\n")
		);
		this.name = "ConfigError";
		this.problems = problems;
	}
}

// An unset variable and one set to nothing (`STALWART_TOKEN=` in a .env file)
// mean the same.
const unsetWhenEmpty = (value: unknown): unknown =>
	value === "" ? undefined : value;
const trimmed = (value: unknown): unknown =>
	typeof value === "string" ? unsetWhenEmpty(value.trim()) : value;

// Secrets are taken as they are: a password may begin or end with a space.
const secret = z.preprocess(unsetWhenEmpty, z.string().optional());
const text = z.preprocess(trimmed, z.string().optional());

const parseHttpUrl = (raw: string): URL | undefined => {
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:"
			? url
			: undefined;
	} catch {
		// Not a URL at all: the caller reports it.
	}
};

const flag = (name: string) =>
	z.preprocess(
		(value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
		z
			.enum(["", "0", "1", "false", "true"], {
				error: `${name} must be 1 (on) or 0 (off).`,
			})
			.optional()
			.transform((value) => value === "1" || value === "true")
	);

const envSchema = z.object({
	LANGMAIL_MCP_ALLOW_REMOTE_IMAGES: flag("LANGMAIL_MCP_ALLOW_REMOTE_IMAGES"),
	LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST: flag(
		"LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST"
	),
	MCP_AUTH_TOKEN: secret,
	MCP_HOST: text,
	MCP_PORT: z.preprocess(
		trimmed,
		z.coerce
			.number({ error: "MCP_PORT must be a port number between 1 and 65535." })
			.int("MCP_PORT must be a port number between 1 and 65535.")
			.min(1, "MCP_PORT must be a port number between 1 and 65535.")
			.max(MAX_PORT, "MCP_PORT must be a port number between 1 and 65535.")
			.optional()
	),
	MCP_PUBLIC_URL: text,
	MCP_TRANSPORT: z.preprocess(
		(value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
		z
			.enum(["", "stdio", "http"], {
				error: 'MCP_TRANSPORT must be "stdio" or "http".',
			})
			.optional()
	),
	STALWART_PASSWORD: secret,
	STALWART_TOKEN: secret,
	STALWART_URL: text,
	STALWART_USERNAME: text,
});

type Env = z.infer<typeof envSchema>;

const readStalwartUrl = (
	env: Env,
	problems: string[],
	warnings: string[]
): string => {
	if (env.STALWART_URL === undefined) {
		problems.push(
			"STALWART_URL is not set. Set it to the base URL of your Stalwart server, for example https://mail.example.com."
		);
		return "";
	}
	const url = parseHttpUrl(env.STALWART_URL);
	if (!url) {
		problems.push(
			"STALWART_URL must be an http:// or https:// URL, for example https://mail.example.com."
		);
		return "";
	}
	if (url.username !== "" || url.password !== "") {
		problems.push(
			"STALWART_URL must not contain a username or password. Put them in STALWART_USERNAME and STALWART_PASSWORD."
		);
		return "";
	}
	if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
		warnings.push(
			`STALWART_URL uses http://, so your credential travels to ${url.host} unencrypted. Use https:// unless that host is on a network you trust.`
		);
	}
	return env.STALWART_URL.replace(TRAILING_SLASHES_RE, "");
};

const basicCredential = (username: string, password: string): string =>
	`Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

const readCredential = (env: Env, problems: string[]): string => {
	const {
		STALWART_PASSWORD: password,
		STALWART_TOKEN: token,
		STALWART_USERNAME: username,
	} = env;
	const hasBasic = username !== undefined || password !== undefined;
	if (token !== undefined && hasBasic) {
		problems.push(
			"Both STALWART_TOKEN and STALWART_USERNAME/STALWART_PASSWORD are set. Use one way to sign in: an app password (username and password) or a token."
		);
		return "";
	}
	if (token !== undefined) {
		return `Bearer ${token}`;
	}
	if (username !== undefined && password !== undefined) {
		if (username.includes(":")) {
			problems.push(
				"STALWART_USERNAME must not contain a colon (HTTP Basic sign-in cannot carry one)."
			);
			return "";
		}
		return basicCredential(username, password);
	}
	if (username !== undefined) {
		problems.push(
			"STALWART_USERNAME is set but STALWART_PASSWORD is not. Set STALWART_PASSWORD to an app password for that account."
		);
	} else if (password === undefined) {
		problems.push(
			"No credential is set. Set STALWART_USERNAME and STALWART_PASSWORD (an app password), or STALWART_TOKEN."
		);
	} else {
		problems.push(
			"STALWART_PASSWORD is set but STALWART_USERNAME is not. Set STALWART_USERNAME to the account's address."
		);
	}
	return "";
};

const readAuthToken = (env: Env, problems: string[]): string => {
	const token = env.MCP_AUTH_TOKEN;
	if (token === undefined) {
		problems.push(
			"MCP_AUTH_TOKEN is not set. The HTTP transport refuses to start without it: set it to a long random secret, which callers send as `Authorization: Bearer <secret>`."
		);
		return "";
	}
	if (!AUTH_TOKEN_RE.test(token)) {
		problems.push(
			"MCP_AUTH_TOKEN must consist of printable ASCII characters without spaces, because callers send it in an HTTP header. `openssl rand -hex 32` makes one."
		);
		return "";
	}
	if (token.length < MIN_AUTH_TOKEN_LENGTH) {
		problems.push(
			`MCP_AUTH_TOKEN is too short: it must be at least ${MIN_AUTH_TOKEN_LENGTH} characters. \`openssl rand -hex 32\` makes one.`
		);
		return "";
	}
	return token;
};

const readHttpTransport = (
	env: Env,
	problems: string[],
	warnings: string[]
): HttpTransportConfig => {
	const host = env.MCP_HOST ?? DEFAULT_HTTP_HOST;
	const port = env.MCP_PORT ?? DEFAULT_HTTP_PORT;
	let publicUrl = `http://${urlHostname(host)}:${port}`;
	if (env.MCP_PUBLIC_URL !== undefined) {
		if (parseHttpUrl(env.MCP_PUBLIC_URL)) {
			publicUrl = env.MCP_PUBLIC_URL.replace(TRAILING_SLASHES_RE, "");
		} else {
			problems.push(
				"MCP_PUBLIC_URL must be an http:// or https:// URL, for example https://mcp.example.com."
			);
		}
	}
	if (!isLoopbackHost(host)) {
		warnings.push(
			`MCP_HOST is ${host}, so the server is reachable from other machines over plain HTTP, and the bearer token and your mail travel unencrypted. Put a reverse proxy that terminates TLS in front of it, and set MCP_PUBLIC_URL to the https:// address callers use.`
		);
	}
	return {
		authToken: readAuthToken(env, problems),
		host,
		kind: "http",
		port,
		publicUrl,
	};
};

const readTransportKind = (
	env: Env,
	argv: readonly string[],
	problems: string[]
): "stdio" | "http" => {
	let fromFlag: "stdio" | "http" | undefined;
	for (const arg of argv) {
		if (arg === "--http") {
			fromFlag = "http";
		} else if (arg === "--stdio") {
			fromFlag = "stdio";
		} else {
			problems.push(
				`Unknown argument ${JSON.stringify(arg)}. The only arguments are --http and --stdio.`
			);
		}
	}
	return fromFlag ?? (env.MCP_TRANSPORT === "http" ? "http" : "stdio");
};

/**
 * Builds the configuration from an environment and the process arguments
 * (without the node binary and script). Throws a {@link ConfigError} listing
 * every problem at once.
 */
export const loadConfig = (
	rawEnv: Record<string, string | undefined>,
	argv: readonly string[] = []
): LoadedConfig => {
	const parsed = envSchema.safeParse(rawEnv);
	if (!parsed.success) {
		// The messages name the variable and never echo its value.
		throw new ConfigError(parsed.error.issues.map((issue) => issue.message));
	}
	const env = parsed.data;
	const problems: string[] = [];
	const warnings: string[] = [];

	const stalwartUrl = readStalwartUrl(env, problems, warnings);
	const credential = readCredential(env, problems);
	const transport: Config["transport"] =
		readTransportKind(env, argv, problems) === "http"
			? readHttpTransport(env, problems, warnings)
			: { kind: "stdio" };

	if (problems.length > 0) {
		throw new ConfigError(problems);
	}
	return {
		config: {
			allowRemoteImages: env.LANGMAIL_MCP_ALLOW_REMOTE_IMAGES,
			allowUnsubscribePost: env.LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST,
			credential,
			stalwartUrl,
			transport,
		},
		warnings,
	};
};
