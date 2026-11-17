// Stalwart's management API for the e2e suites: throwaway accounts with an
// app password, created through the admin's `x:` JMAP methods.

import { ADMIN_AUTH, ADMIN_URL, basicAuth, DOMAIN } from "./env.ts";

const ADMIN_USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"];

/** One admin JMAP method call; throws on an HTTP or method-level error. */
export const adminCall = async (
	method: string,
	args: Record<string, unknown>
): Promise<Record<string, unknown>> => {
	const res = await fetch(`${ADMIN_URL}/jmap/`, {
		body: JSON.stringify({
			methodCalls: [[method, args, "0"]],
			using: ADMIN_USING,
		}),
		headers: { authorization: ADMIN_AUTH, "content-type": "application/json" },
		method: "POST",
	});
	if (res.status !== 200) {
		throw new Error(`${method} returned HTTP ${res.status}`);
	}
	const body = (await res.json()) as {
		methodResponses?: [string, Record<string, unknown>, string][];
	};
	const [name, payload] = body.methodResponses?.[0] ?? [];
	if (name === "error" || !payload) {
		throw new Error(`${method} failed: ${JSON.stringify(body)}`);
	}
	return payload;
};

let cachedDomainId: Promise<string> | undefined;

/** Id of the `example.com` domain the bootstrap created. */
const domainId = (): Promise<string> => {
	cachedDomainId ??= adminCall("x:Domain/query", {
		filter: { name: DOMAIN },
	}).then((result) => {
		const [id] = (result.ids as string[] | undefined) ?? [];
		if (!id) {
			throw new Error(
				`domain ${DOMAIN} missing: run scripts/stalwart/up.sh first`
			);
		}
		return id;
	});
	return cachedDomainId;
};

/**
 * A local part no other run or suite uses: `<name>-<Date.now()>`. Accounts
 * left behind by a killed run then never collide with a new one.
 */
export const uniqueLocalPart = (name: string): string =>
	`${name}-${Date.now()}`;

export interface TestAccount {
	/** The mailbox address, `<localPart>@example.com`; also the login name. */
	address: string;
	/** Complete `Authorization` header value: Basic, address + app password. */
	authorization: string;
	/** Stalwart's id of the account, for admin calls. */
	id: string;
	localPart: string;
	/** The app password. */
	secret: string;
}

const created: TestAccount[] = [];

/**
 * Creates a user account under `example.com` and an app password for it.
 * `localPart` is used as given; pass `uniqueLocalPart("name")` for a fresh
 * one. `aliases` are further local parts under the same domain that deliver
 * to this account.
 */
export const createAccount = async (options: {
	aliases?: string[];
	localPart: string;
}): Promise<TestAccount> => {
	const { localPart, aliases = [] } = options;
	const domain = await domainId();
	const accounts = await adminCall("x:Account/set", {
		create: {
			a1: {
				"@type": "User",
				domainId: domain,
				name: localPart,
				roles: { "@type": "User" },
				...(aliases.length > 0
					? {
							aliases: Object.fromEntries(
								aliases.map((name, index) => [
									String(index),
									{ description: name, domainId: domain, enable: true, name },
								])
							),
						}
					: {}),
			},
		},
	});
	const id = (accounts.created as { a1?: { id?: string } } | undefined)?.a1?.id;
	if (!id) {
		throw new Error(`account not created: ${JSON.stringify(accounts)}`);
	}
	const passwords = await adminCall("x:AppPassword/set", {
		accountId: id,
		create: {
			ap1: {
				allowedIps: {},
				description: "langmail-mcp e2e",
				permissions: { "@type": "Inherit" },
			},
		},
	});
	const secret = (
		passwords.created as { ap1?: { secret?: string } } | undefined
	)?.ap1?.secret;
	if (!secret) {
		// Do not leave an account behind that nothing can log in to.
		await adminCall("x:Account/set", { destroy: [id] });
		throw new Error(`app password not created: ${JSON.stringify(passwords)}`);
	}
	const address = `${localPart}@${DOMAIN}`;
	const account: TestAccount = {
		address,
		authorization: basicAuth(address, secret),
		id,
		localPart,
		secret,
	};
	created.push(account);
	return account;
};

/** Destroys one account; its mail, calendars and contacts go with it. */
export const destroyAccount = async (
	account: Pick<TestAccount, "id">
): Promise<void> => {
	const index = created.findIndex((entry) => entry.id === account.id);
	if (index >= 0) {
		created.splice(index, 1);
	}
	await adminCall("x:Account/set", { destroy: [account.id] });
};

/**
 * Destroys every account this test file created through `createAccount` and
 * has not destroyed yet. Meant for `afterAll(destroyCreatedAccounts)`: vitest
 * loads this module once per test file, so the list is the file's own.
 */
export const destroyCreatedAccounts = async (): Promise<void> => {
	const ids = created.splice(0).map((account) => account.id);
	if (ids.length > 0) {
		await adminCall("x:Account/set", { destroy: ids });
	}
};
