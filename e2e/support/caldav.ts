// What the calendar suites share: a test account seen as a CalDAV principal,
// and waiting for (or ruling out) the scheduling mail Stalwart sends to local
// attendees when an organizer's event changes.

import { type CalDavConfig, discoverAccount } from "../../src/caldav/client.ts";
import { createAccount, type TestAccount, uniqueLocalPart } from "./admin.ts";
import { ADMIN_URL } from "./env.ts";
import {
	allMessages,
	jmapCall,
	type MailSession,
	openMailSession,
	waitForMessage,
} from "./mail.ts";
import { sleep } from "./wait.ts";

/** CalDAV against the server under test; the credential goes out unchanged. */
export const CALDAV_CFG: CalDavConfig = { serverUrl: ADMIN_URL };

export interface Principal {
	account: TestAccount;
	/** The mailbox address. */
	addr: string;
	/** The account's `Authorization` header value, for raw requests. */
	basic: string;
	cfg: CalDavConfig;
	/** URL of the calendar Stalwart provisions for every account. */
	defaultUrl: string;
	/** The account's JMAP session, for reading what was delivered. */
	mail: MailSession;
	/** The calendar-user address discovery reports for the account. */
	organizer: string;
	/** What the tools and the CalDAV client take as `token`: the credential. */
	token: string;
}

/**
 * Creates an account (`<name>-<timestamp>@example.com`, or `localPart` as
 * given) and discovers its calendars. Destroyed with the file's other accounts
 * by `destroyCreatedAccounts`.
 */
export const provisionPrincipal = async (
	name: string,
	options: { aliases?: string[]; localPart?: string } = {}
): Promise<Principal> => {
	const account = await createAccount({
		aliases: options.aliases,
		localPart: options.localPart ?? uniqueLocalPart(name),
	});
	const token = account.authorization;
	const discovery = await discoverAccount(CALDAV_CFG, token);
	if (!(discovery.defaultCalendarUrl && discovery.organizer)) {
		throw new Error(`discovery incomplete: ${JSON.stringify(discovery)}`);
	}
	return {
		account,
		addr: account.address,
		basic: account.authorization,
		cfg: CALDAV_CFG,
		defaultUrl: discovery.defaultCalendarUrl,
		mail: await openMailSession(account.authorization),
		organizer: discovery.organizer,
		token,
	};
};

// Delivery inside the server normally takes a second or two; with other
// suites loading the same server it takes longer.
const DELIVERY_TIMEOUT_MS = 60_000;
const DELIVERY_POLL_MS = 250;
const QUIET_FLOOR_MS = 12_000;
const QUIET_POLL_MS = 500;
// A quiet window lasts this many times the slowest delivery seen so far.
const QUIET_FACTOR = 4;

// The slowest delivery this test file has waited for. A "nothing arrives"
// check is only worth something if it watches for longer than a delivery
// currently takes, so its window grows with this.
let slowestDeliveryMs = 0;

const noteDelivery = (startedAt: number): void => {
	slowestDeliveryMs = Math.max(slowestDeliveryMs, Date.now() - startedAt);
};

/** How long a "nothing arrives" check watches a mailbox. */
export const quietWindowMs = (): number =>
	Math.max(QUIET_FLOOR_MS, QUIET_FACTOR * slowestDeliveryMs);

/** Number of messages in the account, in any mailbox. */
export const messageCount = async (
	p: Pick<Principal, "mail">
): Promise<number> => {
	const result = await jmapCall(p.mail, "Email/query", {});
	return ((result.ids as string[] | undefined) ?? []).length;
};

/**
 * Polls until the account holds more than `previous` messages (a new
 * delivery). False when none arrived within the delivery budget.
 */
export const waitForMoreThan = async (
	p: Pick<Principal, "mail">,
	previous: number
): Promise<boolean> => {
	const startedAt = Date.now();
	while (Date.now() - startedAt < DELIVERY_TIMEOUT_MS) {
		if ((await messageCount(p)) > previous) {
			noteDelivery(startedAt);
			return true;
		}
		await sleep(DELIVERY_POLL_MS);
	}
	return false;
};

/**
 * Like `waitForMoreThan`, but returns every message in the account (decoded
 * source) once a new one is there, or null when none arrived.
 */
export const waitForNewMessages = async (
	p: Pick<Principal, "mail">,
	previous: number
): Promise<string[] | null> =>
	(await waitForMoreThan(p, previous)) ? allMessages(p.mail) : null;

const FOLD_RE = /\r\n[ \t]/gu;

/** Undoes RFC 5545 line folding (CRLF followed by a space or tab). */
export const unfold = (ical: string): string => ical.replace(FOLD_RE, "");

/**
 * Waits for a scheduling message containing `marker` and returns its decoded,
 * unfolded source; throws when none arrives within the delivery budget.
 * Unfolded, so a property split across a fold cannot hide from a later
 * `toContain` or, worse, from a `not.toContain`.
 */
export const calendarMessageWith = async (
	p: Pick<Principal, "mail">,
	marker: string
): Promise<string> => {
	const startedAt = Date.now();
	const source = await waitForMessage(
		p.mail,
		(message) => {
			const text = unfold(message);
			return text.includes("BEGIN:VCALENDAR") && text.includes(marker);
		},
		`calendar message containing ${marker}`,
		{ timeoutMs: DELIVERY_TIMEOUT_MS }
	);
	noteDelivery(startedAt);
	return unfold(source);
};

/**
 * True when the account still holds `expected` messages at the end of a quiet
 * window, i.e. nothing was delivered; false as soon as something arrives. The
 * window is `quietWindowMs()`: at least 12 s, and four times the slowest
 * delivery this file has seen, so a loaded server cannot pass the check just
 * by being slow. Follow it with a change that does notify, to prove the
 * mailbox was reachable all along.
 */
export const staysAt = async (
	p: Pick<Principal, "mail">,
	expected: number
): Promise<boolean> => {
	const deadline = Date.now() + quietWindowMs();
	while (Date.now() < deadline) {
		if ((await messageCount(p)) > expected) {
			return false;
		}
		await sleep(QUIET_POLL_MS);
	}
	return (await messageCount(p)) <= expected;
};
