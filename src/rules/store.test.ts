import { afterEach, describe, expect, test } from "vitest";

import type {
	JmapLive,
	JmapSession,
	SieveScriptRecord,
} from "../jmap/index.ts";

import {
	generateSieveScript,
	type MailRule,
	RULES_SCRIPT_NAME,
} from "./rule.ts";
import { makeLiveSieveIo, makeMailRulesStore, type SieveIo } from "./store.ts";

const rule: MailRule = {
	actions: [{ type: "archive" }],
	conditions: { from: "notifications@github.example.com" },
	enabled: true,
	id: "rule-1a2b3c4d",
	match: "all",
	name: "Automatically archive all GitHub notifications",
};

// An in-memory SieveIo simulating a single-script Stalwart account. Blob and
// script state cross calls so load/save sequences behave like the real thing.
const fakeIo = (): SieveIo & {
	calls: string[];
	script: { blobId: string; id: string } | null;
} => {
	const blobs = new Map<string, string>();
	let nextBlob = 0;
	const io = {
		calls: [] as string[],
		createScript: (_t: string, blobId: string) => {
			io.calls.push("create");
			io.script = { blobId, id: "script-1" };
			return Promise.resolve();
		},
		downloadScript: (_t: string, blobId: string) => {
			io.calls.push("download");
			return Promise.resolve(blobs.get(blobId) ?? "");
		},
		findScript: (_t: string) => {
			io.calls.push("find");
			return Promise.resolve(io.script);
		},
		script: null as { blobId: string; id: string } | null,
		updateScript: (_t: string, scriptId: string, blobId: string) => {
			io.calls.push("update");
			io.script = { blobId, id: scriptId };
			return Promise.resolve();
		},
		uploadScript: (_t: string, content: string) => {
			io.calls.push("upload");
			const blobId = `blob-${nextBlob}`;
			nextBlob += 1;
			blobs.set(blobId, content);
			return Promise.resolve(blobId);
		},
	};
	return io;
};

describe("makeMailRulesStore", () => {
	test("load returns [] when no managed script exists yet", async () => {
		const io = fakeIo();
		expect(await makeMailRulesStore(io).load("tok")).toEqual([]);
		expect(io.calls).toEqual(["find"]);
	});

	test("first save creates and activates the script; later saves update it", async () => {
		const io = fakeIo();
		const store = makeMailRulesStore(io);
		await store.save("tok", [rule]);
		expect(io.calls).toContain("create");
		await store.save("tok", [
			rule,
			{ ...rule, id: "rule-eeeeeeee", name: "Second" },
		]);
		expect(io.calls).toContain("update");
		expect(await store.load("tok")).toHaveLength(2);
	});

	test("save → load round-trips the rule list through the generated script", async () => {
		const io = fakeIo();
		const store = makeMailRulesStore(io);
		await store.save("tok", [rule]);
		expect(await store.load("tok")).toEqual([rule]);
		// The stored blob is the canonical generated script, not some other encoding.
		expect(io.script).not.toBeNull();
		expect(await io.downloadScript("tok", io.script?.blobId ?? "")).toBe(
			generateSieveScript([rule])
		);
	});
});

// --- live wiring -------------------------------------------------------------

const SERVER = "https://mail.example.test";
const API_URL = `${SERVER}/jmap/`;
const SIEVE_ACCOUNT = "acct-sieve";
const MAIL_ACCOUNT = "acct-mail";

const session = (primaryAccounts: Record<string, string>): JmapSession => ({
	apiUrl: API_URL,
	downloadUrl: `${SERVER}/download/{accountId}/{blobId}/{name}/{type}`,
	primaryAccounts,
	uploadUrl: `${SERVER}/upload/{accountId}/`,
});

const SIEVE_SESSION = session({
	"urn:ietf:params:jmap:mail": MAIL_ACCOUNT,
	"urn:ietf:params:jmap:sieve": SIEVE_ACCOUNT,
});

interface StubCall {
	authorization: string | undefined;
	body: string | undefined;
	method: string;
	url: string;
}

// One entry of a JMAP request's `methodCalls`: name, arguments, call id.
type MethodCall = [string, Record<string, unknown>, string];
const EMPTY_CALL: MethodCall = ["", {}, "0"];

interface StubOptions {
	// The bytes a blob download hands back.
	scriptContent?: string;
	// What SieveScript/get reports the account holds.
	scripts?: SieveScriptRecord[];
}

// A `JmapLive` that answers with a fixed session and records the Authorization
// header the store resolved it under — the `authorize` seam's observable edge.
const fakeLive = (jmapSession: JmapSession, seen: string[]): JmapLive => ({
	getSession: (authorization) => {
		seen.push(authorization);
		return Promise.resolve(jmapSession);
	},
	resolveAccountId: () =>
		Promise.reject(new Error("unexpected resolveAccountId")),
});

// Stubs the three wire shapes makeLiveSieveIo drives: the blob upload POST, the
// blob download GET and the JMAP API POST (SieveScript/get and /set). Every
// request is recorded so the account id, headers and payload can be asserted.
const installFetch = (options: StubOptions = {}): StubCall[] => {
	const calls: StubCall[] = [];
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const body = typeof init?.body === "string" ? init.body : undefined;
		calls.push({
			authorization: (init?.headers as Record<string, string> | undefined)
				?.authorization,
			body,
			method: init?.method ?? "GET",
			url,
		});

		if (url.startsWith(`${SERVER}/upload/`)) {
			return Promise.resolve(Response.json({ blobId: "blob-uploaded" }));
		}
		if (url.startsWith(`${SERVER}/download/`)) {
			return Promise.resolve(new Response(options.scriptContent ?? ""));
		}

		const parsed = JSON.parse(body ?? "{}") as { methodCalls?: MethodCall[] };
		const [name, args] = parsed.methodCalls?.[0] ?? EMPTY_CALL;
		if (name === "SieveScript/get") {
			return Promise.resolve(
				Response.json({
					methodResponses: [[name, { list: options.scripts ?? [] }, "0"]],
				})
			);
		}
		// SieveScript/set is create-or-update depending on which argument is present.
		const updateIds = Object.keys(
			(args.update ?? {}) as Record<string, unknown>
		);
		const result = args.create
			? { created: { s0: { id: "script-created" } } }
			: { updated: Object.fromEntries(updateIds.map((id) => [id, null])) };
		return Promise.resolve(
			Response.json({ methodResponses: [[name, result, "0"]] })
		);
	}) as typeof fetch;

	return calls;
};

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const managedScript = {
	blobId: "blob-managed",
	id: "script-managed",
	isActive: true,
	name: RULES_SCRIPT_NAME,
};
const otherScript = {
	blobId: "blob-other",
	id: "script-other",
	isActive: false,
	name: "vacation",
};

const liveIo = (
	jmapSession: JmapSession = SIEVE_SESSION,
	authorize?: (token: string) => string
): { io: SieveIo; sessionAuth: string[] } => {
	const sessionAuth: string[] = [];
	const live = fakeLive(jmapSession, sessionAuth);
	return {
		io: authorize ? makeLiveSieveIo(live, authorize) : makeLiveSieveIo(live),
		sessionAuth,
	};
};

describe("makeLiveSieveIo", () => {
	test("findScript returns the managed script handle, ignoring the account’s other scripts", async () => {
		installFetch({ scripts: [otherScript, managedScript] });
		expect(await liveIo().io.findScript("tok")).toEqual({
			blobId: "blob-managed",
			id: "script-managed",
		});
	});

	test("findScript returns null when the account holds no managed script yet", async () => {
		installFetch({ scripts: [otherScript] });
		expect(await liveIo().io.findScript("tok")).toBeNull();
	});

	test("findScript asks for every script on the sieve primary account", async () => {
		const calls = installFetch({ scripts: [managedScript] });
		await liveIo().io.findScript("tok");

		const [get] = calls.filter((c) => c.url === API_URL);
		expect(get?.method).toBe("POST");
		expect(JSON.parse(get?.body ?? "{}")).toMatchObject({
			methodCalls: [
				["SieveScript/get", { accountId: SIEVE_ACCOUNT, ids: null }, "0"],
			],
		});
	});

	test("uploadScript POSTs the content to the session upload URL and returns the blob id", async () => {
		const calls = installFetch();
		expect(await liveIo().io.uploadScript("tok", 'require ["fileinto"];')).toBe(
			"blob-uploaded"
		);

		const upload = calls.find((c) => c.url.startsWith(`${SERVER}/upload/`));
		expect(upload?.url).toBe(`${SERVER}/upload/${SIEVE_ACCOUNT}/`);
		expect(upload?.method).toBe("POST");
		expect(upload?.body).toBe('require ["fileinto"];');
	});

	test("downloadScript fetches the blob as the managed sieve script and returns its text", async () => {
		const calls = installFetch({ scriptContent: "# langmail rules\r\n" });
		expect(await liveIo().io.downloadScript("tok", "blob-managed")).toBe(
			"# langmail rules\r\n"
		);

		const download = calls.find((c) => c.url.startsWith(`${SERVER}/download/`));
		expect(download?.url).toBe(
			`${SERVER}/download/${SIEVE_ACCOUNT}/blob-managed/${RULES_SCRIPT_NAME}.sieve/application%2Fsieve`
		);
		expect(download?.method).toBe("GET");
	});

	test("createScript creates the script under the managed name and activates it", async () => {
		const calls = installFetch();
		await liveIo().io.createScript("tok", "blob-uploaded");

		const set = calls.find((c) => c.url === API_URL);
		expect(JSON.parse(set?.body ?? "{}")).toMatchObject({
			methodCalls: [
				[
					"SieveScript/set",
					{
						accountId: SIEVE_ACCOUNT,
						create: {
							s0: { blobId: "blob-uploaded", name: RULES_SCRIPT_NAME },
						},
						onSuccessActivateScript: "#s0",
					},
					"0",
				],
			],
		});
	});

	test("updateScript points the existing script at the new blob and reactivates it", async () => {
		const calls = installFetch();
		await liveIo().io.updateScript("tok", "script-managed", "blob-uploaded");

		const set = calls.find((c) => c.url === API_URL);
		expect(JSON.parse(set?.body ?? "{}")).toMatchObject({
			methodCalls: [
				[
					"SieveScript/set",
					{
						accountId: SIEVE_ACCOUNT,
						onSuccessActivateScript: "script-managed",
						update: { "script-managed": { blobId: "blob-uploaded" } },
					},
					"0",
				],
			],
		});
	});

	test("the credential is passed through unchanged by default", async () => {
		const calls = installFetch({ scripts: [managedScript] });
		const { io, sessionAuth } = liveIo();
		await io.findScript("Bearer tok");

		expect(sessionAuth).toEqual(["Bearer tok"]);
		expect(calls.at(-1)?.authorization).toBe("Bearer tok");

		await io.findScript("Basic ZGV2OnBhc3N3b3Jk");

		expect(sessionAuth).toEqual(["Bearer tok", "Basic ZGV2OnBhc3N3b3Jk"]);
		expect(calls.at(-1)?.authorization).toBe("Basic ZGV2OnBhc3N3b3Jk");
	});

	test("a custom authorize seam pins its header on both the session lookup and the wire call", async () => {
		const calls = installFetch({ scripts: [managedScript] });
		const { io, sessionAuth } = liveIo(
			SIEVE_SESSION,
			() => "Basic ZGV2OnBhc3N3b3Jk"
		);
		await io.findScript("tok");

		expect(sessionAuth).toEqual(["Basic ZGV2OnBhc3N3b3Jk"]);
		expect(calls.at(-1)?.authorization).toBe("Basic ZGV2OnBhc3N3b3Jk");
	});

	test("falls back to the mail primary account when the session names no sieve primary", async () => {
		const calls = installFetch({ scripts: [] });
		const mailOnly = session({ "urn:ietf:params:jmap:mail": MAIL_ACCOUNT });
		await liveIo(mailOnly).io.findScript("tok");

		expect(JSON.parse(calls.at(-1)?.body ?? "{}")).toMatchObject({
			methodCalls: [["SieveScript/get", { accountId: MAIL_ACCOUNT }, "0"]],
		});
	});

	test("every call resolves the session again — the io itself caches nothing", async () => {
		installFetch({ scripts: [managedScript] });
		const { io, sessionAuth } = liveIo();
		await io.findScript("Bearer tok");
		await io.findScript("Bearer tok");
		await io.uploadScript("Bearer tok", "require [];");

		expect(sessionAuth).toEqual(["Bearer tok", "Bearer tok", "Bearer tok"]);
	});
});
