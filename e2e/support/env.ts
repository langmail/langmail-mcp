// Where the e2e suites find the live Stalwart and how they log in as admin.
// `scripts/stalwart/up.sh` starts and bootstraps a server these defaults match.

import { describe } from "vitest";

const TRAILING_SLASH = /\/$/u;

/** Base URL of the Stalwart under test; empty when the suites should skip. */
export const ADMIN_URL = (process.env.STALWART_ADMIN_URL ?? "").replace(
	TRAILING_SLASH,
	""
);

/** `Authorization` header value of the server's admin. */
export const ADMIN_AUTH =
	process.env.STALWART_ADMIN_AUTHORIZATION ??
	`Basic ${Buffer.from("admin:devpassword").toString("base64")}`;

/** The mail domain the bootstrap creates; every test account lives under it. */
export const DOMAIN = "example.com";

/**
 * `describe` for a suite that needs the live server. It skips when
 * `STALWART_ADMIN_URL` is unset, so the suite never fails for lack of one.
 */
export const live = ADMIN_URL ? describe : describe.skip;

/** A Basic `Authorization` header value. */
export const basicAuth = (username: string, password: string): string =>
	`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
