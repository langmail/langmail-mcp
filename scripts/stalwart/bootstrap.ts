// Prepares a fresh Stalwart for the e2e suites, headless, over the admin JMAP
// API (`x:` methods under the `urn:stalwart:jmap` capability). `up.sh` runs it;
// by hand:
//
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 node scripts/stalwart/bootstrap.ts
//
// Steps:
//   1. Wait for the JMAP session endpoint to accept the admin login.
//   2. A fresh server is in bootstrap mode, where only the `Bootstrap` object
//      is reachable. Complete it with `mail.example.com` as hostname and
//      `example.com` as default domain, TLS certificates and DKIM keys off (a
//      test server has no DNS), and logging to stdout: the default tracer
//      writes to /var/log/stalwart, which the docker image never creates.
//      Restart, because the mode change only applies at startup.
//   3. Make sure the `example.com` domain exists. The suites create their
//      throwaway accounts under it.
//   4. Make sure the only tracer writes to stdout (`docker logs`, or the log
//      file of `local.sh`).
//   5. Answer CardDAV requests that name no vCard version with 3.0, the
//      setting the contact suites are written against.
//   6. Turn the automatic IP bans off. Every suite talks to the server from
//      one address, so a suite that sends wrong passwords on purpose would
//      otherwise get that address, and with it every later suite, banned.
//   7. With STALWART_HTTP_BIND set (binary mode): replace the default
//      listeners, which open ports 25, 443, 465, 993, 995, 4190 and 8080 on
//      every interface, with one HTTP listener on that address.
//   8. Restart if a step changed something, because these settings are read at
//      startup.
//
// Running it again on a prepared server changes nothing and restarts nothing.
//
// Environment:
//   STALWART_ADMIN_URL            default http://127.0.0.1:9090
//   STALWART_ADMIN_AUTHORIZATION  default Basic admin:devpassword
//   STALWART_RESTART_CMD          shell command that restarts the server
//                                 (default: docker restart langmail-mcp-stalwart)
//   STALWART_DATA_DIR             binary mode: where the server keeps its data
//                                 (default: Stalwart's own, /var/lib/stalwart)
//   STALWART_HTTP_BIND            binary mode: the one listener to keep, e.g.
//                                 127.0.0.1:9090

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const TRAILING_SLASH = /\/$/u;
const ADMIN_URL = (
	process.env.STALWART_ADMIN_URL ?? "http://127.0.0.1:9090"
).replace(TRAILING_SLASH, "");
const AUTHORIZATION =
	process.env.STALWART_ADMIN_AUTHORIZATION ??
	`Basic ${Buffer.from("admin:devpassword").toString("base64")}`;
const RESTART_CMD =
	process.env.STALWART_RESTART_CMD ?? "docker restart langmail-mcp-stalwart";
const DATA_DIR = process.env.STALWART_DATA_DIR;
const HTTP_BIND = process.env.STALWART_HTTP_BIND;

const HOSTNAME = "mail.example.com";
const DOMAIN = "example.com";
const USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"];
const ADMIN_CAPABILITY = "urn:stalwart:jmap";
const STDOUT_TRACER = {
	"@type": "Stdout",
	ansi: false,
	enable: true,
	level: "info",
	multiline: false,
};
const BAN_SETTINGS = [
	"abuseBanRate",
	"authBanRate",
	"loiterBanRate",
	"scanBanRate",
];

interface JmapSession {
	accounts?: Record<string, unknown>;
	apiUrl?: string;
	primaryAccounts?: Record<string, string>;
}

interface Resolved {
	accountId: string;
	apiUrl: string;
}

interface CallResult {
	error?: string;
	payload: Record<string, unknown>;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

// One attempt at the session endpoint. The API URL is always built from
// STALWART_ADMIN_URL rather than taken from the session, so the script also
// works where the advertised public URL is not reachable.
const readSession = async (): Promise<Resolved | string> => {
	try {
		const res = await fetch(`${ADMIN_URL}/jmap/session`, {
			headers: { authorization: AUTHORIZATION },
		});
		if (res.status !== 200) {
			return `session returned ${res.status}`;
		}
		const body = (await res.json()) as JmapSession;
		const accountId =
			body.primaryAccounts?.[ADMIN_CAPABILITY] ??
			Object.keys(body.accounts ?? {})[0];
		return accountId
			? { accountId, apiUrl: `${ADMIN_URL}/jmap/` }
			: "malformed session (no account id)";
	} catch (error) {
		return errorText(error);
	}
};

const waitForSession = (): Promise<Resolved> => {
	const deadline = Date.now() + 90_000;
	const attempt = async (): Promise<Resolved> => {
		const result = await readSession();
		if (typeof result !== "string") {
			return result;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`Stalwart not reachable at ${ADMIN_URL} after 90s (last: ${result})`
			);
		}
		await sleep(500);
		return attempt();
	};
	return attempt();
};

const call = async (
	s: Resolved,
	method: string,
	args: Record<string, unknown>
): Promise<CallResult> => {
	const res = await fetch(s.apiUrl, {
		body: JSON.stringify({
			methodCalls: [[method, { accountId: s.accountId, ...args }, "0"]],
			using: USING,
		}),
		headers: {
			authorization: AUTHORIZATION,
			"content-type": "application/json",
		},
		method: "POST",
	});
	if (res.status !== 200) {
		throw new Error(
			`${method} returned HTTP ${res.status}: ${await res.text()}`
		);
	}
	const body = (await res.json()) as {
		methodResponses?: [string, Record<string, unknown>, string][];
	};
	const response = body.methodResponses?.[0];
	if (!response) {
		throw new Error(`${method}: empty methodResponses`);
	}
	const [name, payload] = response;
	if (name === "error") {
		return {
			error: String(payload.description ?? JSON.stringify(payload)),
			payload,
		};
	}
	return { payload };
};

// Restarts the server and waits until it answers again. `recovery` asks a
// binary-mode restart for recovery mode (see local.sh); `docker restart` keeps
// the container's own environment and ignores it.
const restart = async (recovery = false): Promise<Resolved> => {
	const { STALWART_RECOVERY_MODE: _dropped, ...env } = process.env;
	try {
		await promisify(execFile)("sh", ["-c", RESTART_CMD], {
			env: recovery ? { ...env, STALWART_RECOVERY_MODE: "1" } : env,
		});
	} catch (error) {
		throw new Error(`restart (${RESTART_CMD}) failed: ${errorText(error)}`, {
			cause: error,
		});
	}
	// The old process may still answer for a moment after the command returns.
	await sleep(500);
	return waitForSession();
};

const completeBootstrap = async (s: Resolved): Promise<void> => {
	console.log("Server in bootstrap mode, completing setup...");
	const { payload, error } = await call(s, "x:Bootstrap/set", {
		update: {
			singleton: {
				defaultDomain: DOMAIN,
				defaultHostname: HOSTNAME,
				generateDkimKeys: false,
				requestTlsCertificate: false,
				tracer: STDOUT_TRACER,
				...(DATA_DIR
					? { dataStore: { "@type": "RocksDb", path: `${DATA_DIR}/` } }
					: {}),
			},
		},
	});
	const updated = payload.updated as Record<string, unknown> | undefined;
	if (error || !(updated && "singleton" in updated)) {
		throw new Error(
			`bootstrap completion failed: ${JSON.stringify(payload.notUpdated ?? error ?? payload)}`
		);
	}
};

// Singletons always exist under the fixed id `singleton`. A failed update is
// reported under `notUpdated`; a successful one may carry a null value.
const setSingleton = async (
	s: Resolved,
	type: string,
	fields: Record<string, unknown>
): Promise<void> => {
	const { payload, error } = await call(s, `${type}/set`, {
		update: { singleton: fields },
	});
	const notUpdated = (payload.notUpdated as Record<string, unknown> | undefined)
		?.singleton;
	if (error || notUpdated) {
		throw new Error(
			`${type} update failed: ${JSON.stringify(notUpdated ?? error ?? payload)}`
		);
	}
};

const getSingleton = async (
	s: Resolved,
	type: string,
	properties: string[]
): Promise<Record<string, unknown>> => {
	const { payload, error } = await call(s, `${type}/get`, {
		ids: ["singleton"],
		properties,
	});
	const record = (payload.list as Record<string, unknown>[] | undefined)?.[0];
	if (error || !record) {
		throw new Error(`${type}/get failed: ${error ?? JSON.stringify(payload)}`);
	}
	return record;
};

const queryIds = async (s: Resolved, type: string): Promise<string[]> => {
	const { payload, error } = await call(s, `${type}/query`, {});
	if (error) {
		throw new Error(`${type}/query failed: ${error}`);
	}
	return (payload.ids as string[] | undefined) ?? [];
};

const ensureDomain = async (s: Resolved): Promise<void> => {
	const query = await call(s, "x:Domain/query", { filter: { name: DOMAIN } });
	if (query.error) {
		throw new Error(`Domain/query failed: ${query.error}`);
	}
	const existingId = (query.payload.ids as string[] | undefined)?.[0];
	if (existingId) {
		console.log(`Domain ${DOMAIN} present (id=${existingId}).`);
		return;
	}
	const { payload, error } = await call(s, "x:Domain/set", {
		create: { d1: { "@type": "Domain", enable: true, name: DOMAIN } },
	});
	const id = (payload.created as { d1?: { id?: string } } | undefined)?.d1?.id;
	if (error || !id) {
		throw new Error(
			`domain not created: ${JSON.stringify(payload.notCreated ?? error ?? payload)}`
		);
	}
	console.log(`Created domain ${DOMAIN} (id=${id}).`);
};

const applyStdoutTracer = async (s: Resolved): Promise<boolean> => {
	const ids = await queryIds(s, "x:Tracer");
	if (ids.length === 1) {
		const get = await call(s, "x:Tracer/get", { ids, properties: ["@type"] });
		const [tracer] =
			(get.payload.list as { "@type"?: string }[] | undefined) ?? [];
		if (tracer?.["@type"] === "Stdout") {
			return false;
		}
	}
	const { payload, error } = await call(s, "x:Tracer/set", {
		create: { stdout: STDOUT_TRACER },
		destroy: ids,
	});
	const created = (payload.created as { stdout?: { id?: string } } | undefined)
		?.stdout?.id;
	if (error || !created) {
		throw new Error(
			`stdout tracer not created: ${JSON.stringify(payload.notCreated ?? error ?? payload)}`
		);
	}
	console.log("Tracer switched to stdout.");
	return true;
};

const applyVCard3Default = async (s: Resolved): Promise<boolean> => {
	const current = await getSingleton(s, "x:AddressBook", ["vCardVersion"]);
	if (current.vCardVersion === "v3") {
		return false;
	}
	await setSingleton(s, "x:AddressBook", { vCardVersion: "v3" });
	console.log("Default vCard version set to 3.0.");
	return true;
};

const applyNoIpBans = async (s: Resolved): Promise<boolean> => {
	const current = await getSingleton(s, "x:Security", BAN_SETTINGS);
	if (BAN_SETTINGS.every((name) => (current[name] ?? null) === null)) {
		return false;
	}
	await setSingleton(
		s,
		"x:Security",
		Object.fromEntries(BAN_SETTINGS.map((name) => [name, null]))
	);
	console.log("Automatic IP bans turned off.");
	return true;
};

interface ListenerRecord {
	bind?: Record<string, boolean>;
	id: string;
	protocol?: string;
}

const applySingleHttpListener = async (
	s: Resolved,
	bind: string
): Promise<boolean> => {
	const ids = await queryIds(s, "x:NetworkListener");
	const get = await call(s, "x:NetworkListener/get", {
		ids,
		properties: ["bind", "protocol"],
	});
	const listeners = (get.payload.list as ListenerRecord[] | undefined) ?? [];
	const isTarget = (l: ListenerRecord): boolean =>
		l.protocol === "http" && Object.keys(l.bind ?? {}).join() === bind;
	const [only] = listeners;
	if (listeners.length === 1 && only && isTarget(only)) {
		return false;
	}
	const { payload, error } = await call(s, "x:NetworkListener/set", {
		create: {
			http: {
				bind: { [bind]: true },
				name: "http-e2e",
				protocol: "http",
				useTls: false,
			},
		},
		destroy: ids,
	});
	const created = (payload.created as { http?: { id?: string } } | undefined)
		?.http?.id;
	const notDestroyed = payload.notDestroyed as
		| Record<string, unknown>
		| undefined;
	if (error || !created || Object.keys(notDestroyed ?? {}).length > 0) {
		throw new Error(
			`listeners not replaced: ${JSON.stringify(payload.notCreated ?? notDestroyed ?? error ?? payload)}`
		);
	}
	console.log(`Listeners replaced by one HTTP listener on ${bind}.`);
	return true;
};

const main = async (): Promise<void> => {
	const startedAt = Date.now();
	console.log(`Waiting for Stalwart at ${ADMIN_URL} ...`);
	let session = await waitForSession();

	// A fresh server rejects every admin method but Bootstrap with a
	// `forbidden` error whose description names bootstrap mode.
	const probe = await call(session, "x:Domain/query", {});
	if (probe.error?.toLowerCase().includes("bootstrap")) {
		await completeBootstrap(session);
		console.log(
			"Bootstrap completed, restarting so the mode change applies..."
		);
		// In binary mode the restart is into recovery mode, so the default
		// listeners are replaced before the server ever opens them.
		session = await restart(Boolean(HTTP_BIND));
	} else if (probe.error) {
		throw new Error(`Domain/query failed: ${probe.error}`);
	}

	await ensureDomain(session);
	const changes = [
		await applyStdoutTracer(session),
		await applyVCard3Default(session),
		await applyNoIpBans(session),
		HTTP_BIND ? await applySingleHttpListener(session, HTTP_BIND) : false,
	];
	if (changes.some(Boolean)) {
		console.log("Restarting so the new settings load...");
		await restart();
	}

	const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
	console.log(`\nStalwart ready after ${seconds}s. Run the e2e suites with:\n`);
	console.log(`  STALWART_ADMIN_URL=${ADMIN_URL} npm run test:e2e`);
};

try {
	await main();
} catch (error) {
	console.error(`\nStalwart bootstrap failed: ${errorText(error)}`);
	process.exitCode = 1;
}
