// Proves that this server offers an agent the same tools as the hosted
// Langmail MCP server: same names, order, titles, descriptions, input and
// output schemas, annotations and metadata, the same instructions and the
// same resources.
//
// `hosted-tools.snapshot.json` is what the hosted server sends over the wire:
// the `instructions` of its `initialize` result and its complete `tools/list`
// and `resources/list` results, in wire order. `source` names the commit of
// the hosted server it was taken from. One value in it is configuration and
// not definition, the hosted server's own public origin in the viewer
// resource's CSP; it is replaced by `https://mcp.example.com` (the fixture's
// `normalised` field says so), which is the public URL this test configures.
//
// To regenerate it: send `initialize`, `tools/list` and `resources/list`
// (following `nextCursor`) to the hosted server at the commit to compare
// against, write `instructions`, `tools` and `resources` into the file as they
// arrive, replace the origin as above, update `source`, and format the file
// with `npm run check:fix`. Then run this test: every difference it reports is
// either a change to bring over or a new entry for one of the two tables
// below.
//
// The two tables are the only differences allowed. `LEFT_OUT` names the hosted
// tools this server does not have. `REWORDED` lists every place where this
// server's text differs, with the exact hosted wording, the exact wording
// here, and why. The test applies each entry to the hosted definition and
// requires the result to equal what this server sends, so a difference that
// is not listed fails, and so does an entry that no longer applies. To change
// a description, change it in the tool's file and add or update its entry
// here.

import { describe, expect, test } from "vitest";
import type { Config } from "../config.ts";
import { createServer } from "./handler.ts";
import snapshot from "./hosted-tools.snapshot.json" with { type: "json" };
import { connect } from "./test-client.ts";

const PUBLIC_URL = "https://mcp.example.com";

interface Flags {
	allowRemoteImages: boolean;
	allowUnsubscribePost: boolean;
	// Whether the server speaks stdio. Over HTTP it is configured with
	// PUBLIC_URL as its public URL.
	stdio: boolean;
}

// The server is checked as it starts by default (stdio, both opt-in flags
// off), as an HTTP server with the flags off, and with both flags on.
const MODES: { flags: Flags; name: string }[] = [
	{
		flags: {
			allowRemoteImages: false,
			allowUnsubscribePost: false,
			stdio: true,
		},
		name: "stdio, opt-in flags off (the default)",
	},
	{
		flags: {
			allowRemoteImages: false,
			allowUnsubscribePost: false,
			stdio: false,
		},
		name: "HTTP, opt-in flags off",
	},
	{
		flags: {
			allowRemoteImages: true,
			allowUnsubscribePost: true,
			stdio: false,
		},
		name: "HTTP, both opt-in flags on",
	},
];

const LEFT_OUT: Record<string, string> = {
	share_calendar:
		"Sharing a calendar by link needs the hosted service's database and its calendar feed service.",
	stop_sharing_calendar:
		"Ends a share made by share_calendar, which is left out.",
};

interface Reworded {
	// The exact text this server has in its place. For a value that is not a
	// string: the value here, or `undefined` when this server leaves it out.
	here: unknown;
	// The exact hosted text that differs: a part of the string at `path` that
	// occurs there once. For a value that is not a string: the whole value.
	hosted: unknown;
	// Where in the target, as a dotted path: "description",
	// "inputSchema.properties.attachments.description". Empty for the
	// instructions, which are one string.
	path: string;
	// "tool:<name>", "resource:<name>" or "instructions".
	target: string;
	// Only in the runs whose flags have these values; in every run when absent.
	when?: Partial<Flags>;
	why: string;
}

const NO_CALENDAR_SHARING =
	"Calendar sharing (share_calendar, stop_sharing_calendar) is left out, so no calendar has shares to list.";
const LINK_IS_NOT_ALWAYS_HTTPS =
	"This server serves the link itself: over stdio from a loopback listener (http://127.0.0.1:…), over HTTP under MCP_PUBLIC_URL, which is https only behind a TLS proxy.";
const SERVER_MAY_BE_LOCAL =
	"Over stdio this server runs on the agent's own computer. It still reads no file paths, so the rest of the sentence holds.";
const ONE_CLICK_IS_OPT_IN =
	"The one-click request goes to a host the sender chose, so it is sent only with LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST on. With it off the tool hands the link back.";
const ATTACHMENTS_HOSTED =
	"A file path cannot be used: this server runs elsewhere and cannot read your disk";
const ATTACHMENTS_HERE =
	"A file path cannot be used: this server cannot read your disk";

const REWORDED: Reworded[] = [
	{
		here: undefined,
		hosted: { resourceDomains: [PUBLIC_URL] },
		path: "_meta.ui.csp",
		target: "resource:email-viewer",
		when: { stdio: true },
		why: "The CSP names the origin the viewer's images load from. Over stdio that is a loopback listener which starts with the first link, so the listing cannot name it yet; reading the resource does.",
	},
	{
		here: "Langmail works on the user’s own email, calendar and contacts account on their Stalwart mail server, plus",
		hosted:
			"Langmail is the user’s own email, calendar and contacts account, plus",
		path: "",
		target: "instructions",
		why: "Here Langmail is the set of tools, not the account: the account is on the user's own Stalwart server.",
	},
	{
		here: "list_calendars for the calendars themselves.",
		hosted:
			"list_calendars for the calendars themselves and who each is shared with. share_calendar shares one with a person at busy times only or full details and gives back a link the user passes on; it is shown only once. stop_sharing_calendar ends a share.",
		path: "",
		target: "instructions",
		why: NO_CALENDAR_SHARING,
	},
	{
		here: "delivering mail (reply_to_message, forward_message, send_draft) and changing or cancelling",
		hosted:
			"delivering mail (reply_to_message, forward_message, send_draft), unsubscribing the user from a mailing list (unsubscribe_from_list) and changing or cancelling",
		path: "",
		target: "instructions",
		when: { allowUnsubscribePost: false },
		why: `${ONE_CLICK_IS_OPT_IN} A call that sends nothing is not among the actions that cannot be undone.`,
	},
	{
		here: "Confirm with the user who it reaches and what it says first, unless they have already asked for exactly that. unsubscribe_from_list sends nothing on this server (LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST is off): it returns the sender’s unsubscribe link or address for the user to use themselves.",
		hosted:
			"Confirm with the user who it reaches and what it says (for an unsubscribe: which sender) first, unless they have already asked for exactly that.",
		path: "",
		target: "instructions",
		when: { allowUnsubscribePost: false },
		why: `${ONE_CLICK_IS_OPT_IN} The instructions say so, because they are what an agent reads before it picks a tool.`,
	},
	{
		here: "use mark_emails for that. Filter first",
		hosted:
			"use mark_emails for that. Read and starred state are Langmail's own: marking a message in Langmail does not change it in a linked Gmail account. Filter first",
		path: "description",
		target: "tool:search_emails",
		why: "Linking a Gmail account is a feature of the hosted service. Here read and starred state are the mailbox's own flags, which every mail client sees.",
	},
	{
		here: "sends the request itself (only with LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST on; it is off on this server, so the link is returned instead). It never sends mail",
		hosted: "sends the request itself. It never sends mail",
		path: "description",
		target: "tool:unsubscribe_from_list",
		when: { allowUnsubscribePost: false },
		why: ONE_CLICK_IS_OPT_IN,
	},
	{
		here: "The result is metadata plus a URL",
		hosted: "The result is metadata plus an HTTPS URL",
		path: "description",
		target: "tool:download_attachment",
		why: LINK_IS_NOT_ALWAYS_HTTPS,
	},
	{
		here: "The result is the filename, size and a URL",
		hosted: "The result is the filename, size and an HTTPS URL",
		path: "description",
		target: "tool:download_email",
		why: LINK_IS_NOT_ALWAYS_HTTPS,
	},
	{
		here: "to rename or recolor. Returns",
		hosted:
			"to rename or recolor, or to answer who can see the user’s calendars. Returns",
		path: "description",
		target: "tool:list_calendars",
		why: NO_CALENDAR_SHARING,
	},
	{
		here: "CalDAV URL and color when it has one;",
		hosted:
			"CalDAV URL, color when it has one, and every person it is shared with at which level (the share links themselves cannot be shown again);",
		path: "description",
		target: "tool:list_calendars",
		why: NO_CALENDAR_SHARING,
	},
	{
		here: "to move events onto one use move_calendar_events.",
		hosted:
			"to move events onto one use move_calendar_events; to share one or stop a share use share_calendar or stop_sharing_calendar.",
		path: "description",
		target: "tool:list_calendars",
		why: NO_CALENDAR_SHARING,
	},
	{
		here: "the draft shows up in the user’s mail client for the user to review",
		hosted: "the draft shows up in Langmail for the user to review",
		path: "description",
		target: "tool:create_draft",
		why: "There is no Langmail app in front of a self-hosted mailbox: the draft is in the Drafts folder, where any mail client shows it.",
	},
	{
		here: ATTACHMENTS_HERE,
		hosted: ATTACHMENTS_HOSTED,
		path: "inputSchema.properties.attachments.description",
		target: "tool:create_draft",
		why: SERVER_MAY_BE_LOCAL,
	},
	{
		here: ATTACHMENTS_HERE,
		hosted: ATTACHMENTS_HOSTED,
		path: "inputSchema.properties.attachments.description",
		target: "tool:update_draft",
		why: SERVER_MAY_BE_LOCAL,
	},
];

type Json = Record<string, unknown>;

interface Listed extends Json {
	name: string;
}

const hosted = snapshot as unknown as {
	instructions: string;
	resources: Listed[];
	tools: Listed[];
};

const config = ({ stdio, ...flags }: Flags): Config => ({
	...flags,
	credential: "Bearer token",
	stalwartUrl: "https://mail.example.com",
	transport: stdio
		? { kind: "stdio" }
		: {
				authToken: "a-long-random-secret",
				host: "127.0.0.1",
				kind: "http",
				port: 8080,
				publicUrl: PUBLIC_URL,
			},
});

// What the real server sends. Neither the handshake nor a listing touches
// Stalwart, so the placeholder URLs are never dialled.
const served = async (
	flags: Flags
): Promise<{ instructions: unknown; resources: Listed[]; tools: Listed[] }> => {
	const client = await connect(createServer(config(flags)));
	const listAll = async (method: string, key: string): Promise<Listed[]> => {
		const items: Listed[] = [];
		let cursor: unknown;
		do {
			const result = await client.request(
				method,
				cursor === undefined ? {} : { cursor }
			);
			items.push(...(result[key] as Listed[]));
			cursor = result.nextCursor;
		} while (cursor !== undefined);
		return items;
	};
	const { capabilities, instructions } = client.initialized;
	const tools = await listAll("tools/list", "tools");
	// A server without resources does not answer resources/list at all.
	const resources =
		(capabilities as Json | undefined)?.resources === undefined
			? []
			: await listAll("resources/list", "resources");
	await client.close();
	// The in-memory transport hands objects over as they are; a real one sends
	// JSON, which drops fields that are undefined.
	return JSON.parse(JSON.stringify({ instructions, resources, tools }));
};

const applies = (entry: Reworded, flags: Flags): boolean =>
	Object.entries(entry.when ?? {}).every(
		([flag, value]) => flags[flag as keyof Flags] === value
	);

const describeEntry = (entry: Reworded): string =>
	`REWORDED entry for ${entry.target}${entry.path ? ` at ${entry.path}` : ""}`;

// Replaces the one occurrence of `entry.hosted` in `text`.
const rewordText = (text: string, entry: Reworded): string => {
	if (typeof entry.hosted !== "string" || typeof entry.here !== "string") {
		throw new Error(
			`${describeEntry(entry)}: the hosted value is a string, so "hosted" and "here" must be strings`
		);
	}
	const occurrences = text.split(entry.hosted).length - 1;
	if (occurrences !== 1) {
		throw new Error(
			`${describeEntry(entry)}: its hosted text occurs ${occurrences} times in the hosted definition, expected once. The entry is unused or ambiguous:\n${entry.hosted}`
		);
	}
	return text.replace(entry.hosted, () => entry.here as string);
};

// Applies one entry to a copy of a hosted tool or resource, in place.
const rewordAt = (target: Json, entry: Reworded): void => {
	const keys = entry.path.split(".");
	const last = keys.pop() as string;
	let holder = target;
	for (const key of keys) {
		const next = holder[key];
		if (typeof next !== "object" || next === null) {
			throw new Error(
				`${describeEntry(entry)}: the hosted definition has nothing at that path`
			);
		}
		holder = next as Json;
	}
	const current = holder[last];
	if (typeof current === "string") {
		holder[last] = rewordText(current, entry);
		return;
	}
	expect(
		current,
		`${describeEntry(entry)}: "hosted" must be the whole hosted value`
	).toStrictEqual(entry.hosted);
	if (entry.here === undefined) {
		delete holder[last];
	} else {
		holder[last] = entry.here;
	}
};

// The hosted definition as this server should send it: a copy with the
// entries for `target` applied.
const expectedFor = <T>(target: string, hostedValue: T, flags: Flags): T => {
	const entries = REWORDED.filter(
		(entry) => entry.target === target && applies(entry, flags)
	);
	if (typeof hostedValue === "string") {
		return entries.reduce(rewordText, hostedValue as string) as T;
	}
	const copy = structuredClone(hostedValue) as Json;
	for (const entry of entries) {
		rewordAt(copy, entry);
	}
	return copy as T;
};

const hostedToolNames = hosted.tools.map((tool) => tool.name);
const keptTools = hosted.tools.filter((tool) => !(tool.name in LEFT_OUT));
// Every tool name is snake_case with at least one underscore; plain prose
// words are not.
const TOOL_NAME_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu;

describe("the exception tables", () => {
	test("LEFT_OUT names hosted tools, each with a reason", () => {
		for (const [name, reason] of Object.entries(LEFT_OUT)) {
			expect(hostedToolNames).toContain(name);
			expect(reason.trim()).not.toBe("");
		}
	});

	test("every REWORDED entry points at something this server has, says why, and applies in at least one run", () => {
		const targets = new Set([
			"instructions",
			...keptTools.map((tool) => `tool:${tool.name}`),
			...hosted.resources.map((resource) => `resource:${resource.name}`),
		]);
		for (const entry of REWORDED) {
			expect(targets, describeEntry(entry)).toContain(entry.target);
			expect(entry.why.trim(), describeEntry(entry)).not.toBe("");
			expect(entry.here, describeEntry(entry)).not.toStrictEqual(entry.hosted);
			expect(
				MODES.some((mode) => applies(entry, mode.flags)),
				`${describeEntry(entry)} applies in no run`
			).toBe(true);
		}
	});
});

describe.each(MODES)("parity with the hosted server, $name", ({ flags }) => {
	test("offers exactly the hosted tools minus LEFT_OUT, in the hosted order", async () => {
		const { tools } = await served(flags);
		expect(tools.map((tool) => tool.name)).toEqual(
			keptTools.map((tool) => tool.name)
		);
		expect(tools).toHaveLength(hostedToolNames.length - 2);
	});

	// One test per tool, so a failure names the tool and shows only its diff.
	test.each(keptTools.map((tool) => tool.name))(
		"%s is defined as on the hosted server",
		async (name) => {
			const { tools } = await served(flags);
			const ours = tools.find((tool) => tool.name === name);
			const theirs = keptTools.find((tool) => tool.name === name) as Listed;
			// The whole definition: name, title, description, inputSchema,
			// annotations, outputSchema, _meta, and no further field on either side.
			expect(ours).toStrictEqual(expectedFor(`tool:${name}`, theirs, flags));
		}
	);

	test("sends the hosted instructions", async () => {
		const { instructions } = await served(flags);
		expect(instructions).toBe(
			expectedFor("instructions", hosted.instructions, flags)
		);
	});

	test("lists the hosted resources", async () => {
		const { resources } = await served(flags);
		expect(resources).toStrictEqual(
			hosted.resources.map((resource) =>
				expectedFor(`resource:${resource.name}`, resource, flags)
			)
		);
	});

	test("no description, input schema or instruction names a tool this server does not have", async () => {
		const { instructions, tools } = await served(flags);
		const registered = new Set(tools.map((tool) => tool.name));
		const texts: [string, string][] = [
			["instructions", String(instructions)],
			...tools.map((tool): [string, string] => [
				tool.name,
				JSON.stringify([tool.description, tool.inputSchema, tool.outputSchema]),
			]),
		];
		const strays: string[] = [];
		for (const [where, text] of texts) {
			for (const leftOut of Object.keys(LEFT_OUT)) {
				if (text.includes(leftOut)) {
					strays.push(`${where} names ${leftOut}`);
				}
			}
			for (const token of new Set(text.match(TOOL_NAME_RE) ?? [])) {
				if (hostedToolNames.includes(token) && !registered.has(token)) {
					strays.push(`${where} names ${token}`);
				}
			}
		}
		expect([...new Set(strays)]).toEqual([]);
	});
});
