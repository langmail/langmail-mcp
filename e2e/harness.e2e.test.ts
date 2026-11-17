// Proves the e2e harness itself against a live Stalwart: the server
// `scripts/stalwart/up.sh` started and bootstrapped offers everything the
// other suites build on, and the shared helpers in `e2e/support/` work.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import { afterAll, beforeAll, expect, test } from "vitest";
import {
	adminCall,
	createAccount,
	destroyAccount,
	destroyCreatedAccounts,
	type TestAccount,
	uniqueLocalPart,
} from "./support/admin.ts";
import { ADMIN_URL, basicAuth, DOMAIN, live } from "./support/env.ts";
import {
	importEmail,
	jmapCall,
	type MailSession,
	mailboxId,
	openMailSession,
	uploadBlob,
	waitForCalendarMessage,
	waitForMessage,
} from "./support/mail.ts";
import { untilIndexed } from "./support/wait.ts";

const SUBMISSION_USING = [
	"urn:ietf:params:jmap:core",
	"urn:ietf:params:jmap:mail",
	"urn:ietf:params:jmap:submission",
];
const SIEVE_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:sieve"];
const CONTACTS_USING = [
	"urn:ietf:params:jmap:core",
	"urn:ietf:params:jmap:contacts",
];
const DELIVERY_TIMEOUT_MS = 30_000;
const HREF_RE = /<D:href>([^<]+)<\/D:href>/u;

const propfind = (
	authorization: string,
	path: string,
	props: string,
	depth = "0"
): Promise<Response> =>
	fetch(`${ADMIN_URL}${path}`, {
		body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${props}</d:prop></d:propfind>`,
		headers: {
			authorization,
			"content-type": "application/xml",
			depth,
		},
		method: "PROPFIND",
		redirect: "manual",
	});

// Sends a plain-text message through JMAP: a draft, then its submission.
const sendMail = async (
	from: MailSession,
	to: string,
	subject: string
): Promise<void> => {
	const [drafts, identities] = await Promise.all([
		mailboxId(from, "drafts"),
		jmapCall(from, "Identity/get", {}, SUBMISSION_USING),
	]);
	const [identity] = identities.list as { id: string }[];
	const draft = await jmapCall(from, "Email/set", {
		create: {
			m: {
				bodyValues: { body: { value: `Body of ${subject}` } },
				from: [{ email: from.username }],
				keywords: { $draft: true },
				mailboxIds: { [drafts]: true },
				subject,
				textBody: [{ partId: "body", type: "text/plain" }],
				to: [{ email: to }],
			},
		},
	});
	const emailId = (draft.created as { m?: { id?: string } } | undefined)?.m?.id;
	if (!emailId) {
		throw new Error(`draft not created: ${JSON.stringify(draft)}`);
	}
	const submission = await jmapCall(
		from,
		"EmailSubmission/set",
		{ create: { s: { emailId, identityId: identity?.id } } },
		SUBMISSION_USING
	);
	if (!(submission.created as { s?: unknown } | undefined)?.s) {
		throw new Error(`mail not submitted: ${JSON.stringify(submission)}`);
	}
};

live("e2e harness against live Stalwart", () => {
	const run = Date.now();
	let alice: TestAccount;
	let bob: TestAccount;
	let aliceMail: MailSession;
	let bobMail: MailSession;

	beforeAll(async () => {
		alice = await createAccount({
			aliases: [`harness-alias-${run}`],
			localPart: `harness-alice-${run}`,
		});
		bob = await createAccount({ localPart: `harness-bob-${run}` });
		aliceMail = await openMailSession(alice.authorization);
		bobMail = await openMailSession(bob.authorization);
	});

	afterAll(destroyCreatedAccounts);

	test("an account's app password opens a JMAP session under its address", () => {
		expect(alice.address).toBe(`harness-alice-${run}@${DOMAIN}`);
		expect(aliceMail.username).toBe(alice.address);
		// Absolute URLs under the address the suites use (STALWART_PUBLIC_URL).
		expect(aliceMail.apiUrl).toBe(`${ADMIN_URL}/jmap/`);
		expect(aliceMail.capabilities).toEqual(
			expect.arrayContaining([
				"urn:ietf:params:jmap:mail",
				"urn:ietf:params:jmap:submission",
				"urn:ietf:params:jmap:sieve",
				"urn:ietf:params:jmap:contacts",
				"urn:ietf:params:jmap:calendars",
			])
		);
	});

	test("the well-known JMAP URL leads to the same session", async () => {
		const res = await fetch(`${ADMIN_URL}/.well-known/jmap`, {
			headers: { authorization: alice.authorization },
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { username: string }).username).toBe(
			alice.address
		);
	});

	test("a wrong password gets 401 and no credential gets no account", async () => {
		const wrong = await fetch(`${ADMIN_URL}/jmap/session`, {
			headers: { authorization: basicAuth(alice.address, "not-the-secret") },
		});
		expect(wrong.status).toBe(401);

		// Stalwart answers a session request that carries no credential with
		// 200 and an empty, anonymous session; the API itself refuses it.
		const anonymous = await fetch(`${ADMIN_URL}/jmap/session`);
		expect(anonymous.status).toBe(200);
		expect(await anonymous.json()).toMatchObject({
			accounts: {},
			username: "",
		});
		const api = await fetch(`${ADMIN_URL}/jmap/`, {
			body: JSON.stringify({
				methodCalls: [["Mailbox/get", { accountId: aliceMail.accountId }, "0"]],
				using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(api.status).toBe(401);
	});

	test("an imported email is found by text search once indexed", async () => {
		const word = `quokka${run}`;
		const id = await importEmail(aliceMail, {
			body: `The ${word} report is attached.`,
			from: "Reports <reports@example.com>",
			keywords: { $seen: true },
			subject: "Monthly report",
		});
		const ids = await untilIndexed(
			async () =>
				(await jmapCall(aliceMail, "Email/query", { filter: { text: word } }))
					.ids as string[],
			(found) => found.length > 0,
			`imported email matching "${word}"`
		);
		expect(ids).toEqual([id]);

		const got = await jmapCall(aliceMail, "Email/get", {
			ids,
			properties: ["subject", "keywords", "mailboxIds"],
		});
		expect(got.list).toEqual([
			{
				id,
				// Stalwart adds this one itself on import.
				keywords: { $hasnoattachment: true, $seen: true },
				mailboxIds: { [await mailboxId(aliceMail, "inbox")]: true },
				subject: "Monthly report",
			},
		]);
	});

	test(
		"mail sent to a local account and to an alias is delivered",
		async () => {
			const subject = `harness delivery ${run}`;
			await sendMail(aliceMail, bob.address, subject);
			const delivered = await waitForMessage(
				bobMail,
				(source) => source.includes(`Subject: ${subject}`),
				subject,
				{ timeoutMs: DELIVERY_TIMEOUT_MS - 5000 }
			);
			expect(delivered).toContain(`Body of ${subject}`);

			const aliasSubject = `harness alias ${run}`;
			await sendMail(bobMail, `harness-alias-${run}@${DOMAIN}`, aliasSubject);
			await waitForMessage(
				aliceMail,
				(source) => source.includes(`Subject: ${aliasSubject}`),
				aliasSubject,
				{ timeoutMs: DELIVERY_TIMEOUT_MS - 5000 }
			);
		},
		2 * DELIVERY_TIMEOUT_MS
	);

	test(
		"an active Sieve script files delivered mail",
		async () => {
			const created = await jmapCall(bobMail, "Mailbox/set", {
				create: { f: { name: "Filed" } },
			});
			const filed = (created.created as { f?: { id?: string } } | undefined)?.f
				?.id;
			expect(filed, JSON.stringify(created)).toBeDefined();

			const script = [
				'require ["fileinto"];',
				`if header :contains "subject" "sieve ${run}" { fileinto "Filed"; }`,
			].join("\r\n");
			const blobId = await uploadBlob(bobMail, script, "application/sieve");
			const set = await jmapCall(
				bobMail,
				"SieveScript/set",
				{
					create: { s: { blobId, name: "harness" } },
					onSuccessActivateScript: "#s",
				},
				SIEVE_USING
			);
			expect(set.created, JSON.stringify(set)).toHaveProperty("s");
			const scripts = await jmapCall(
				bobMail,
				"SieveScript/get",
				{},
				SIEVE_USING
			);
			expect(scripts.list).toEqual([
				expect.objectContaining({ isActive: true, name: "harness" }),
			]);

			const subject = `harness sieve ${run}`;
			await sendMail(aliceMail, bob.address, subject);
			await waitForMessage(
				bobMail,
				(source) => source.includes(`Subject: ${subject}`),
				subject,
				{ timeoutMs: DELIVERY_TIMEOUT_MS - 5000 }
			);
			const inFiled = await jmapCall(bobMail, "Email/get", {
				ids: (
					await jmapCall(bobMail, "Email/query", {
						filter: { inMailbox: filed },
					})
				).ids,
				properties: ["subject"],
			});
			expect(inFiled.list).toEqual([expect.objectContaining({ subject })]);
		},
		DELIVERY_TIMEOUT_MS
	);

	test("the account has a default address book, served as vCard 3.0", async () => {
		const books = await jmapCall(
			aliceMail,
			"AddressBook/get",
			{},
			CONTACTS_USING
		);
		expect(books.list).toEqual([expect.objectContaining({ isDefault: true })]);
		const cards = await jmapCall(
			aliceMail,
			"ContactCard/get",
			{},
			CONTACTS_USING
		);
		expect(cards.list).toEqual([]);

		// The bootstrap's server-wide setting.
		const setting = await adminCall("x:AddressBook/get", {
			ids: ["singleton"],
			properties: ["vCardVersion"],
		});
		expect(setting.list).toEqual([
			expect.objectContaining({ vCardVersion: "v3" }),
		]);
	});

	test("CalDAV discovery leads to the account's default calendar", async () => {
		const wellKnown = await propfind(
			alice.authorization,
			"/.well-known/caldav",
			"<d:current-user-principal/>"
		);
		expect(wellKnown.status).toBe(307);
		const davRoot = wellKnown.headers.get("location") ?? "";
		expect(new URL(davRoot, ADMIN_URL).pathname).toBe("/dav/cal");

		const root = await propfind(
			alice.authorization,
			davRoot,
			"<d:current-user-principal/>"
		);
		expect(root.status).toBe(207);
		const principal = HREF_RE.exec(
			(await root.text()).split("current-user-principal")[1] ?? ""
		)?.[1];
		expect(principal).toBe(`/dav/pal/${encodeURIComponent(alice.address)}/`);

		const home = await propfind(
			alice.authorization,
			principal as string,
			"<c:calendar-home-set/><c:calendar-user-address-set/>"
		);
		expect(home.status).toBe(207);
		const homeXml = await home.text();
		expect(homeXml).toContain(`mailto:${alice.address}`);
		const homeSet = HREF_RE.exec(
			homeXml.split("calendar-home-set")[1] ?? ""
		)?.[1];
		expect(homeSet).toBe(`/dav/cal/${encodeURIComponent(alice.address)}/`);

		const calendars = await propfind(
			alice.authorization,
			homeSet as string,
			"<d:resourcetype/>",
			"1"
		);
		expect(calendars.status).toBe(207);
		expect(await calendars.text()).toContain(`${homeSet}default/`);

		const unauthenticated = await propfind("Basic bm9wZTpub3Bl", davRoot, "");
		expect(unauthenticated.status).toBe(401);
	});

	test(
		"an event saved over CalDAV invites a local attendee by mail",
		async () => {
			const uid = `harness-invite-${run}@e2e.example.com`;
			const start = new Date(run + 30 * 86_400_000);
			const stamp = (date: Date): string =>
				`${date.toISOString().replaceAll(/[-:]/gu, "").slice(0, 15)}Z`;
			const ical = [
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//langmail-mcp//e2e//EN",
				"BEGIN:VEVENT",
				`UID:${uid}`,
				`DTSTAMP:${stamp(new Date(run))}`,
				`DTSTART:${stamp(start)}`,
				`DTEND:${stamp(new Date(start.getTime() + 3_600_000))}`,
				"SUMMARY:Harness invitation",
				`ORGANIZER:mailto:${alice.address}`,
				`ATTENDEE;PARTSTAT=ACCEPTED:mailto:${alice.address}`,
				`ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${bob.address}`,
				"END:VEVENT",
				"END:VCALENDAR",
				"",
			].join("\r\n");
			const put = await fetch(
				`${ADMIN_URL}/dav/cal/${encodeURIComponent(alice.address)}/default/harness-invite-${run}.ics`,
				{
					body: ical,
					headers: {
						authorization: alice.authorization,
						"content-type": "text/calendar; charset=utf-8",
						"if-none-match": "*",
					},
					method: "PUT",
				}
			);
			expect(put.status).toBe(201);

			const invitation = await waitForCalendarMessage(bobMail, `UID:${uid}`, {
				timeoutMs: DELIVERY_TIMEOUT_MS - 5000,
			});
			expect(invitation).toContain("METHOD:REQUEST");
			expect(invitation).toContain("SUMMARY:Harness invitation");
		},
		DELIVERY_TIMEOUT_MS
	);

	test("a destroyed account can no longer log in", async () => {
		const gone = await createAccount({
			localPart: uniqueLocalPart("harness-gone"),
		});
		expect(
			(
				await fetch(`${ADMIN_URL}/jmap/session`, {
					headers: { authorization: gone.authorization },
				})
			).status
		).toBe(200);
		await destroyAccount(gone);
		expect(
			(
				await fetch(`${ADMIN_URL}/jmap/session`, {
					headers: { authorization: gone.authorization },
				})
			).status
		).toBe(401);
		const left = await adminCall("x:Account/query", {
			filter: { name: gone.localPart },
		});
		expect(left.ids).toEqual([]);
	});
});
