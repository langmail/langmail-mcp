import { describe, expect, test } from "vitest";

import { buildEmailSetPatch } from "./patch.ts";

describe("buildEmailSetPatch", () => {
	test("returns an empty patch when neither map is supplied", () => {
		expect(buildEmailSetPatch({})).toEqual({});
		// Present-but-empty takes the other side of the `?? {}` fallback.
		expect(buildEmailSetPatch({ keywords: {}, mailboxIds: {} })).toEqual({});
	});

	test("treats an omitted map as no changes on that axis", () => {
		expect(buildEmailSetPatch({ keywords: { $seen: true } })).toEqual({
			"keywords/$seen": true,
		});
		expect(buildEmailSetPatch({ mailboxIds: { mbx1: true } })).toEqual({
			"mailboxIds/mbx1": true,
		});
	});

	// The shape `sentEmailPatch` produces for an account with no Sent mailbox:
	// a keyword *removal* with `mailboxIds` omitted entirely. Clearing `$draft`
	// is the load-bearing half of a send, so this branch must not collapse to an
	// empty patch.
	test("emits a keyword removal on its own when no mailbox move accompanies it", () => {
		expect(buildEmailSetPatch({ keywords: { $draft: false } })).toEqual({
			"keywords/$draft": false,
		});
	});

	test("prefixes each token with the property it patches", () => {
		expect(
			buildEmailSetPatch({
				keywords: { $seen: true },
				mailboxIds: { mbx1: true },
			})
		).toEqual({
			"keywords/$seen": true,
			"mailboxIds/mbx1": true,
		});
	});

	// The two maps translate onto the wire *differently*, and this asymmetry is
	// the whole reason patch.ts exists: keyword removal is `false` (email-sync's
	// production-proven convention), mailbox removal is `null` (RFC 8620's
	// canonical PatchObject removal). Encoding either one the other way silently
	// no-ops against Stalwart.
	test("removes a keyword with false but a mailbox with null", () => {
		expect(
			buildEmailSetPatch({
				keywords: { $draft: false },
				mailboxIds: { mbDrafts: false },
			})
		).toEqual({
			"keywords/$draft": false,
			"mailboxIds/mbDrafts": null,
		});
	});

	// The dominant production shape: the email-agent's enrichment writer sends
	// the whole `$type:` taxonomy in one map — the classified type `true` and
	// every other type `false` — with agent `$label:` adds layered on top. Each
	// entry has to keep its own polarity; a map-wide collapse either way would
	// strip labels or leave two type keywords behind.
	test("preserves per-entry polarity in a mixed add/remove keyword map", () => {
		expect(
			buildEmailSetPatch({
				keywords: {
					"$type:receipt": true,
					"$type:newsletter": false,
					"$type:travel": false,
					"$label:urgent": true,
				},
			})
		).toEqual({
			"keywords/$type:receipt": true,
			"keywords/$type:newsletter": false,
			"keywords/$type:travel": false,
			"keywords/$label:urgent": true,
		});
	});

	test("keeps adds as boolean true on both axes", () => {
		expect(
			buildEmailSetPatch({
				keywords: { "$label:receipt": true },
				mailboxIds: { mbSent: true },
			})
		).toEqual({
			"keywords/$label:receipt": true,
			"mailboxIds/mbSent": true,
		});
	});

	describe("RFC 6901 JSON Pointer escaping", () => {
		test("escapes / as ~1 and ~ as ~0 in keyword tokens", () => {
			expect(
				buildEmailSetPatch({ keywords: { "a/b": true, "c~d": true } })
			).toEqual({
				"keywords/a~1b": true,
				"keywords/c~0d": true,
			});
		});

		test("escapes / as ~1 and ~ as ~0 in mailbox ids", () => {
			expect(
				buildEmailSetPatch({ mailboxIds: { "a/b": false, "c~d": true } })
			).toEqual({
				"mailboxIds/a~1b": null,
				"mailboxIds/c~0d": true,
			});
		});

		// The ordering discriminator: `~` MUST be escaped before `/`. A token
		// holding both separates the two orders — escaping `/` first would yield
		// `a~0~01b` here, which decodes back to `a~~1b` rather than `a~/b` and
		// patches the wrong key.
		test("escapes ~ before / so a token holding both round-trips", () => {
			expect(
				buildEmailSetPatch({
					keywords: { "a~/b": true },
					mailboxIds: { "a~/b": true },
				})
			).toEqual({
				"keywords/a~0~1b": true,
				"mailboxIds/a~0~1b": true,
			});
		});

		// A literal `~1` in the source token must not be mistaken for an already
		// escaped `/`; it escapes to `~01` and decodes back to `~1`.
		test("escapes a literal ~1 sequence rather than passing it through", () => {
			expect(buildEmailSetPatch({ keywords: { "a~1b": true } })).toEqual({
				"keywords/a~01b": true,
			});
		});

		test("escapes every metacharacter occurrence, not just the first", () => {
			expect(
				buildEmailSetPatch({ keywords: { "$label:a/b/c~d~e": true } })
			).toEqual({
				"keywords/$label:a~1b~1c~0d~0e": true,
			});
		});

		test("leaves a nested agent label keyword pointer intact end to end", () => {
			expect(
				buildEmailSetPatch({ keywords: { "$label:travel/asia~x": true } })
			).toEqual({
				"keywords/$label:travel~1asia~0x": true,
			});
		});
	});

	test("patches keywords and mailboxes that share a token without colliding", () => {
		expect(
			buildEmailSetPatch({
				keywords: { shared: true },
				mailboxIds: { shared: false },
			})
		).toEqual({
			"keywords/shared": true,
			"mailboxIds/shared": null,
		});
	});

	test("does not mutate the caller-supplied changes", () => {
		const changes = { keywords: { $seen: true }, mailboxIds: { mbx1: false } };
		buildEmailSetPatch(changes);
		expect(changes).toEqual({
			keywords: { $seen: true },
			mailboxIds: { mbx1: false },
		});
	});
});
