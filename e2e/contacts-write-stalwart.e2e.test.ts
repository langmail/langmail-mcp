// E2E for the contact write tools against a REAL Stalwart. It walks the
// trace the feature was specified against: an agent is given a person's name
// and postal address in conversation and nothing else, creates a contact
// holding both, reads it back through search_contacts with the postal
// address present, corrects a single field without re-sending the rest, and
// deletes it — none of which needs any other client.
//
// The reason this has to run against a live server rather than a fake: the
// tools write JSContact properties (`addresses` with structured components,
// `phones`, a second note entry alongside the machine-owned one) that
// Stalwart has never been asked to round-trip before. A unit test proves the
// mapping; only this proves the server keeps it.
//
// The tools receive the account's Basic app-password credential as their
// token, the complete Authorization header, exactly as the server hands it
// to them. Nothing is pinned or stubbed between the tools and Stalwart.
//
// Skips unless STALWART_ADMIN_URL is set:
//   scripts/stalwart/up.sh
//   STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e

import { afterAll, beforeAll, expect, test } from "vitest";
import {
	collectContacts,
	collectedUid,
	liveCollectionDeps,
	observationsFromEmail,
	readBirthday,
	readCollected,
	readPostalAddresses,
	sourceOf,
} from "../src/contacts/index.ts";
import {
	addressBookList,
	contactCardGet,
	contactCardQuery,
	contactCardUpdate,
	makeJmapLive,
} from "../src/jmap/index.ts";
import {
	type ContactWriteDeps,
	makeLiveDeps as makeContactWriteDeps,
} from "../src/tools/contact-common.ts";
import {
	createContact,
	createContactInput,
} from "../src/tools/create-contact.ts";
import {
	deleteContact,
	deleteContactInput,
} from "../src/tools/delete-contact.ts";
import {
	listUpcomingBirthdays,
	listUpcomingBirthdaysInput,
} from "../src/tools/list-upcoming-birthdays.ts";
import {
	mergeContacts,
	mergeContactsInput,
} from "../src/tools/merge-contacts.ts";
import {
	makeLiveDeps as makeSearchContactsDeps,
	type SearchContactsDeps,
	searchContacts,
	searchContactsInput,
} from "../src/tools/search-contacts.ts";
import {
	updateContact,
	updateContactInput,
} from "../src/tools/update-contact.ts";
import {
	createAccount,
	destroyCreatedAccounts,
	uniqueLocalPart,
} from "./support/admin.ts";
import { ADMIN_URL, live } from "./support/env.ts";
import { openMailSession } from "./support/mail.ts";
import { untilIndexed } from "./support/wait.ts";

// Other suites load the same server, so indexing can lag well past its
// usual fraction of a second.
const INDEX_TIMEOUT_MS = 30_000;

// The handle create_contact prints, which the other two tools address the
// record by — an agent reads it out of the prose exactly like this.
const CONTACT_ID = /contact_id: (\S+)/u;

live(
	"contact write tools against live Stalwart — author, read back, correct, delete",
	() => {
		const run = Date.now();
		// Invented person; northwind.example is an RFC 2606 reserved domain.
		const PERSON = "Robin Fairweather";
		let address: string;
		let authorization: string;
		// What the tools receive: the complete Authorization header value.
		let TOKEN: string;
		let accountId: string;
		let apiUrl: string;
		let ctx: { accountId: string; apiUrl: string; authorization: string };
		let writeDeps: ContactWriteDeps;
		let searchDeps: SearchContactsDeps;
		let contactId: string;

		beforeAll(async () => {
			const account = await createAccount({
				localPart: uniqueLocalPart("mcp-contact-write-e2e"),
			});
			address = account.address;
			authorization = account.authorization;
			TOKEN = account.authorization;

			const session = await openMailSession(authorization);
			apiUrl = session.apiUrl;
			const jmapLive = makeJmapLive(ADMIN_URL);
			accountId = await jmapLive.resolveAccountId(authorization);
			expect(accountId).toBe(session.accountId);
			ctx = { accountId, apiUrl, authorization };

			// The tools' own live wiring. No calendar is seeded in this file, so
			// an authored contact has no event titles to hydrate.
			writeDeps = makeContactWriteDeps(jmapLive);
			searchDeps = makeSearchContactsDeps(jmapLive, { serverUrl: ADMIN_URL });
		});

		// Throwaway principal; destroying it also drops its address books.
		afterAll(destroyCreatedAccounts);

		test("creates a contact from a name and a postal address alone — no email needed", async () => {
			const result = await createContact(writeDeps, {
				args: createContactInput.parse({
					name: PERSON,
					postalAddresses: [
						{
							city: "München",
							country: "DE",
							label: "home",
							postalCode: "80333",
							street: "Beispielweg 1",
						},
					],
				}),
				token: TOKEN,
			});
			expect(result.isError).toBeUndefined();
			const id = CONTACT_ID.exec(result.content[0]?.text ?? "")?.[1];
			if (!id) {
				throw new Error(
					`no contact_id in create_contact output: ${result.content[0]?.text}`
				);
			}
			contactId = id;

			// Stalwart kept the structured components rather than flattening them.
			const [card] = await contactCardGet({ ...ctx, ids: [contactId] });
			expect(readPostalAddresses(card as NonNullable<typeof card>)).toEqual([
				{
					city: "München",
					country: "DE",
					display: "Beispielweg 1, 80333 München, DE",
					key: "a0",
					label: "home",
					postalCode: "80333",
					street: "Beispielweg 1",
				},
			]);
			expect(sourceOf(card as NonNullable<typeof card>, undefined)).toBe(
				"authored"
			);
		});

		test("the contact landed in the default address book, so it syncs over CardDAV", async () => {
			const books = await addressBookList(ctx);
			const defaultBook = books.find((b) => b.isDefault)?.id;
			const [card] = await contactCardGet({ ...ctx, ids: [contactId] });
			expect(Object.keys(card?.addressBookIds ?? {})).toEqual([
				defaultBook ?? (books[0]?.id as string),
			]);
		});

		test("search_contacts reads it back with the postal address in the detailed response", async () => {
			const result = await searchContacts(searchDeps, {
				args: searchContactsInput.parse({
					query: "Fairweather",
					response_format: "detailed",
				}),
				token: TOKEN,
			});
			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("1 person(s) matched");
			expect(text).toContain(PERSON);
			expect(text).toContain(`contact_id: ${contactId}`);
			expect(text).toContain("[a0] Beispielweg 1, 80333 München, DE (home)");
			expect(text).toContain("source: authored");
		});

		test("corrects a single component without re-sending the rest of the record", async () => {
			// First give the record more to lose, so the correction has something to
			// preserve: a phone, an address, an organization and a note.
			await updateContact(writeDeps, {
				args: updateContactInput.parse({
					addedEmails: [
						{ address: "robin@northwind.example", context: "work" },
					],
					addedPhones: [{ label: "mobile", number: "+49 89 1234567" }],
					contactId,
					note: "Prefers letters.",
					organization: "Northwind",
				}),
				token: TOKEN,
			});

			// The correction: one wrong digit in the postal code, nothing else sent.
			const result = await updateContact(writeDeps, {
				args: updateContactInput.parse({
					contactId,
					updatedPostalAddresses: [{ key: "a0", postalCode: "80331" }],
				}),
				token: TOKEN,
			});
			expect(result.isError).toBeUndefined();

			const [card] = await contactCardGet({ ...ctx, ids: [contactId] });
			const stored = card as NonNullable<typeof card>;
			expect(readPostalAddresses(stored)).toEqual([
				{
					city: "München",
					country: "DE",
					display: "Beispielweg 1, 80331 München, DE",
					key: "a0",
					label: "home",
					postalCode: "80331",
					street: "Beispielweg 1",
				},
			]);
			// Everything the correction did not name survived it.
			expect(Object.values(stored.phones ?? {})[0]?.number).toBe(
				"+49 89 1234567"
			);
			expect(Object.values(stored.organizations ?? {})[0]?.name).toBe(
				"Northwind"
			);
			expect(Object.values(stored.emails ?? {})[0]?.address).toBe(
				"robin@northwind.example"
			);
			expect(result.content[0]?.text).toContain("note: Prefers letters.");
		});

		test("a later derivation adds to the authored card without relabelling or overwriting it", async () => {
			await untilIndexed(
				() =>
					contactCardQuery({
						...ctx,
						filter: { email: "robin@northwind.example" },
					}),
				(found) => found.includes(contactId),
				"the created contact by email",
				INDEX_TIMEOUT_MS
			);
			// The collection call a mail-header collector makes for a batch of new mail,
			// naming the person differently than the user typed.
			await collectContacts(
				liveCollectionDeps,
				ctx,
				observationsFromEmail(
					{
						from: [
							{ email: "robin@northwind.example", name: "R. Fairweather" },
						],
						id: `m-authored-${run}`,
						receivedAt: new Date(run - 86_400_000).toISOString(),
						to: [{ email: address }],
					},
					{ selfAddresses: new Set([address]) }
				)
			);
			// No second card was minted for an address the authored one already holds.
			const ids = await contactCardQuery({
				...ctx,
				filter: { email: "robin@northwind.example" },
			});
			expect(ids).toEqual([contactId]);

			const [card] = await contactCardGet({ ...ctx, ids: [contactId] });
			const stored = card as NonNullable<typeof card>;
			expect(stored.name?.full).toBe(PERSON);
			expect(sourceOf(stored, undefined)).toBe("authored");
			// And the authored fields the fold never touches are still there.
			expect(readPostalAddresses(stored)).toHaveLength(1);
		});

		test("creating the same person again is refused and points at the existing record", async () => {
			const result = await createContact(writeDeps, {
				args: createContactInput.parse({
					emails: [{ address: "Robin@Northwind.example" }],
					name: PERSON,
				}),
				token: TOKEN,
			});
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain(contactId);
		});

		test("a yearless birthday round-trips through Stalwart and shows up as upcoming", async () => {
			// `--MM-DD`: the partial date must come back without a year — a server
			// that filled one in would report a wrong age on every synced device.
			const result = await updateContact(writeDeps, {
				args: updateContactInput.parse({ birthday: "--03-03", contactId }),
				token: TOKEN,
			});
			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text).toContain("birthday: --03-03");

			const [card] = await contactCardGet({ ...ctx, ids: [contactId] });
			expect(readBirthday(card as NonNullable<typeof card>)).toEqual({
				day: 3,
				month: 3,
			});

			const search = await searchContacts(searchDeps, {
				args: searchContactsInput.parse({ query: "Fairweather" }),
				token: TOKEN,
			});
			expect(search.content[0]?.text).toContain("birthday: --03-03");

			const upcoming = await listUpcomingBirthdays(
				{ ...writeDeps, resolveTimeZone: () => Promise.resolve(null) },
				{
					args: listUpcomingBirthdaysInput.parse({
						days: 7,
						from: "2027-03-01",
					}),
					token: TOKEN,
				}
			);
			expect(upcoming.isError).toBeUndefined();
			expect(upcoming.content[0]?.text).toContain(
				`${PERSON} — 2027-03-03 (in 2 days)`
			);
			expect(upcoming.content[0]?.text).toContain(`contact_id: ${contactId}`);
		});

		test("a stored sentinel year 1604 survives the round trip and is read as no year", async () => {
			// Older vCard 3 clients wrote "unknown year" as 1604. This seeds the value
			// over JMAP, so it proves the read-side guard against what Stalwart
			// stores — not whether Stalwart normalises a vCard 3 BDAY on CardDAV
			// import, which needs a raw vCard PUT and is still open.
			await contactCardUpdate({
				...ctx,
				cardId: contactId,
				patch: {
					anniversaries: {
						legacy: { date: { day: 3, month: 3, year: 1604 }, kind: "birth" },
					},
				},
			});
			const [card] = await contactCardGet({ ...ctx, ids: [contactId] });
			expect(readBirthday(card as NonNullable<typeof card>)).toEqual({
				day: 3,
				month: 3,
			});

			// Clearing it removes the birth entry and leaves nothing behind.
			await updateContact(writeDeps, {
				args: updateContactInput.parse({ birthday: "", contactId }),
				token: TOKEN,
			});
			const [cleared] = await contactCardGet({ ...ctx, ids: [contactId] });
			expect(
				readBirthday(cleared as NonNullable<typeof cleared>)
			).toBeUndefined();
		});

		// merge_contacts against the real server: the update and the destroy in
		// one ContactCard/set, the `pref` mark surviving the round trip, and a
		// later message from the merged address landing on the kept card.
		test("merge_contacts folds a collected duplicate into the kept card", async () => {
			const OTHER = "robin.f@example.org";
			const sighting = (id: string) =>
				observationsFromEmail(
					{
						from: [{ email: OTHER, name: "Robin F." }],
						id,
						receivedAt: new Date(run - 3_600_000).toISOString(),
						to: [{ email: address }],
					},
					{ selfAddresses: new Set([address]) }
				);
			await collectContacts(liveCollectionDeps, ctx, sighting(`m-dup-${run}`));
			const [duplicateId] = await untilIndexed(
				() =>
					contactCardQuery({ ...ctx, filter: { uid: collectedUid(OTHER) } }),
				(found) => found.length > 0,
				"the collected duplicate by its uid",
				INDEX_TIMEOUT_MS
			);
			expect(duplicateId).toBeDefined();

			const result = await mergeContacts(
				{ ...searchDeps, ...writeDeps },
				{
					args: mergeContactsInput.parse({
						contactId,
						mergeContactIds: [duplicateId],
					}),
					token: TOKEN,
				}
			);
			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text).toContain("Removed contacts:");
			expect(
				await contactCardGet({ ...ctx, ids: [duplicateId as string] })
			).toEqual([]);

			const [kept] = await contactCardGet({ ...ctx, ids: [contactId] });
			const emails = Object.values(kept?.emails ?? {});
			expect(emails.map((e) => e.address.toLowerCase()).sort()).toEqual([
				OTHER,
				"robin@northwind.example",
			]);
			// The preferred mark is stored and read back, so the merge did not move it.
			expect(emails.find((e) => e.pref === 1)?.address.toLowerCase()).toBe(
				"robin@northwind.example"
			);
			expect(
				readCollected(kept as NonNullable<typeof kept>).addresses[OTHER]?.count
			).toBe(1);

			await untilIndexed(
				() => contactCardQuery({ ...ctx, filter: { email: OTHER } }),
				(found) => found.includes(contactId),
				"the kept contact by its merged address",
				INDEX_TIMEOUT_MS
			);
			await collectContacts(
				liveCollectionDeps,
				ctx,
				sighting(`m-after-merge-${run}`)
			);
			expect(
				await contactCardQuery({ ...ctx, filter: { uid: collectedUid(OTHER) } })
			).toEqual([]);
			const [after] = await contactCardGet({ ...ctx, ids: [contactId] });
			expect(
				readCollected(after as NonNullable<typeof after>).addresses[OTHER]
					?.count
			).toBe(2);
		});

		test("delete_contact removes the card from the account", async () => {
			const result = await deleteContact(writeDeps, {
				args: deleteContactInput.parse({ contactId }),
				token: TOKEN,
			});
			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text).toContain("nothing will bring it back");
			expect(await contactCardGet({ ...ctx, ids: [contactId] })).toEqual([]);

			const search = await untilIndexed(
				() =>
					searchContacts(searchDeps, {
						args: searchContactsInput.parse({ query: "Fairweather" }),
						token: TOKEN,
					}),
				(r) => (r.content[0]?.text ?? "").includes("No contact matched"),
				"the deleted contact dropping out of search",
				INDEX_TIMEOUT_MS
			);
			expect(search.content[0]?.text).toContain("No contact matched");
		});
	}
);
