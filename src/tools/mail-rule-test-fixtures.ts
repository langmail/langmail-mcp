// Shared fakes for the mail-rule tool unit tests: an in-memory store and a
// scriptable applier.

import type {
	ExistingMailApplyResult,
	ExistingMailEstimate,
	MailRulesApplier,
} from "../rules/apply.ts";
import type { MailRule } from "../rules/rule.ts";
import type { MailRulesStore } from "../rules/store.ts";
import type { MailRuleToolDeps } from "./mail-rule-common.ts";

export interface FakeDeps extends MailRuleToolDeps {
	applies: { mode: string; rule: MailRule; scope: string }[];
	rules: MailRule[];
	saves: number;
}

export const NOW = "2026-07-22T12:00:00.000Z";

export const fakeDeps = (
	initial: MailRule[] = [],
	options: {
		applyResult?: ExistingMailApplyResult;
		estimate?: ExistingMailEstimate;
	} = {}
): FakeDeps => {
	const estimate = options.estimate ?? {
		capped: false,
		conversations: 1,
		messages: 2,
	};
	const applyResult = options.applyResult ?? {
		failed: 0,
		matched: 2,
		modified: 2,
		skippedActions: [],
	};
	const deps: FakeDeps = {
		applier: {
			applyToExisting: (_t, rule, mode, scope) => {
				deps.applies.push({ mode, rule, scope });
				return Promise.resolve(applyResult);
			},
			estimate: () => Promise.resolve(estimate),
		} satisfies MailRulesApplier,
		applies: [],
		now: () => NOW,
		rules: initial,
		saves: 0,
		store: {
			load: () => Promise.resolve([...deps.rules]),
			save: (_t: string, rules: MailRule[]) => {
				deps.saves += 1;
				deps.rules = rules;
				return Promise.resolve();
			},
		} satisfies MailRulesStore,
	};
	return deps;
};

export const githubRule = (overrides: Partial<MailRule> = {}): MailRule => ({
	actions: [{ type: "archive" }],
	conditions: { from: "notifications@github.example.com" },
	createdAt: NOW,
	enabled: true,
	id: "rule-00000001",
	match: "all",
	name: "Archive GitHub Notifications",
	updatedAt: NOW,
	...overrides,
});
