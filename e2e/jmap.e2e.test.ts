// Proves the JMAP client in `src/jmap` against a live Stalwart, signed in the
// two ways the server supports: an app password (a Basic credential) and an
// API key (a Bearer credential). Both go through the same path a tool takes:
// `loadConfig` builds the credential from the environment, the runtime signs
// in with it and learns the principal, and the wrappers run a query.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import { afterAll, beforeAll, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
	accountIdForMail,
	authorizationHeader,
	emailGet,
	emailQuery,
	JmapError,
	makeJmapLive,
} from "../src/jmap/index.ts";
import { createRuntime } from "../src/mcp/handler.ts";
import {
	createAccount,
	createBearerCredential,
	destroyCreatedAccounts,
	type TestAccount,
} from "./support/admin.ts";
import { ADMIN_URL, live } from "./support/env.ts";
import { importEmail, openMailSession } from "./support/mail.ts";

live("src/jmap against live Stalwart", () => {
	const run = Date.now();
	let account: TestAccount;
	let bearer: string;
	let emailId: string;

	beforeAll(async () => {
		account = await createAccount({ localPart: `jmap-${run}` });
		bearer = await createBearerCredential(account);
		emailId = await importEmail(await openMailSession(account.authorization), {
			body: "Seeded for the JMAP client suite.",
			from: "Sender <sender@example.com>",
			subject: `jmap suite ${run}`,
		});
	});

	afterAll(destroyCreatedAccounts);

	// What the server is configured with, per way of signing in.
	const environments = (): Record<string, Record<string, string>> => ({
		"an API key (Bearer)": {
			STALWART_TOKEN: bearer.slice("Bearer ".length),
			STALWART_URL: ADMIN_URL,
		},
		"an app password (Basic)": {
			STALWART_PASSWORD: account.secret,
			STALWART_URL: ADMIN_URL,
			STALWART_USERNAME: account.address,
		},
	});

	test.each([
		["an app password (Basic)", "Basic "],
		["an API key (Bearer)", "Bearer "],
	])(
		"%s signs in, names the principal and reads the mailbox",
		async (name, scheme) => {
			const { config } = loadConfig(environments()[name] ?? {});
			expect(config.credential.startsWith(scheme)).toBe(true);
			const runtime = createRuntime(config);

			// The principal is the mailbox address, learned from the session.
			await runtime.signIn();
			expect(runtime.getPrincipal()).toBe(account.address);

			// What every tool does with its token.
			const authorization = authorizationHeader(runtime.getToken());
			const session = await runtime.jmapLive.getSession(authorization);
			expect(session.username).toBe(account.address);
			expect(session.apiUrl).toBe(`${ADMIN_URL}/jmap/`);
			const accountId = await runtime.jmapLive.resolveAccountId(authorization);
			expect(accountId).toBe(accountIdForMail(session));

			// Email/query without a text filter reads the store, not the search
			// index, so the seeded message is there at once.
			const call = { accountId, apiUrl: session.apiUrl, authorization };
			const ids = await emailQuery({ ...call, filters: {}, limit: 10 });
			expect(ids).toEqual([emailId]);
			const [email] = await emailGet({ ...call, ids });
			expect(email?.subject).toBe(`jmap suite ${run}`);
			expect(email?.from?.[0]?.email).toBe("sender@example.com");
		}
	);

	test("a wrong password is refused with the status, and sign-in says what to check", async () => {
		const { config } = loadConfig({
			STALWART_PASSWORD: "not-the-secret",
			STALWART_URL: ADMIN_URL,
			STALWART_USERNAME: account.address,
		});
		const refused = await makeJmapLive(config.stalwartUrl)
			.getSession(authorizationHeader(config.credential))
			.catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(JmapError);
		expect((refused as JmapError).status).toBe(401);

		await expect(createRuntime(config).signIn()).rejects.toThrow(
			"rejected the credential (HTTP 401)"
		);
	});
});
