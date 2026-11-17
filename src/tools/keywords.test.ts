import { describe, expect, test } from "vitest";
import { EMAIL_TYPE_VALUES } from "./email-types.ts";

import {
	KEYWORD_VALUES,
	KEYWORDS_DESCRIPTION,
	keywordToJmapKeyword,
} from "./keywords.ts";

const SLUG_RE = /^[a-z][a-z0-9_]*$/u;

describe("keyword vocabulary", () => {
	test("enum values are the classification taxonomy plus todo, in taxonomy order", () => {
		expect([...KEYWORD_VALUES]).toEqual([...EMAIL_TYPE_VALUES, "todo"]);
	});

	// The types no agent covers — the gap that kept a cinema booking out of
	// every keyword search.
	test("exposes the types no agent maps", () => {
		expect(KEYWORD_VALUES).toContain("ticket");
		expect(KEYWORD_VALUES).toContain("scheduling");
	});

	// Slug-stability guard: the enum values are used verbatim as JMAP keyword
	// suffixes, so every taxonomy key must already be a lowercase slug (no
	// sanitize step needed). If someone adds a type with uppercase or spaces,
	// this fails loudly.
	test("every enum value is a stable lowercase slug", () => {
		for (const value of KEYWORD_VALUES) {
			expect(value).toMatch(SLUG_RE);
		}
	});

	test("maps email types to $type: keywords", () => {
		expect(keywordToJmapKeyword("ticket")).toBe("$type:ticket");
		expect(keywordToJmapKeyword("receipt")).toBe("$type:receipt");
		expect(keywordToJmapKeyword("order")).toBe("$type:order");
		expect(keywordToJmapKeyword("security_alert")).toBe("$type:security_alert");
	});

	// `receipt` used to resolve to the agent label, which one agent writes for
	// both receipts and orders — the conflation this remap fixes.
	test("receipt no longer resolves to the coarse agent label", () => {
		expect(keywordToJmapKeyword("receipt")).not.toBe("$label:receipt");
	});

	test("maps todo to the $label: agent flag", () => {
		// Canonical since the JMAP-first agent migration — no legacy `to-do` alias.
		expect(keywordToJmapKeyword("todo")).toBe("$label:todo");
	});

	test("the enum description glosses every value", () => {
		for (const value of KEYWORD_VALUES) {
			expect(KEYWORDS_DESCRIPTION).toContain(`"${value}"`);
		}
	});

	// The guidance is the half of this feature that changes agent behaviour;
	// without it a model still reaches for free-text first.
	test("the description tells the model when free-text search is the wrong strategy", () => {
		expect(KEYWORDS_DESCRIPTION).toContain("after/before");
		expect(KEYWORDS_DESCRIPTION.toLowerCase()).toContain(
			"predate classification"
		);
	});
});
