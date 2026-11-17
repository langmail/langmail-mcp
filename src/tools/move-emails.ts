// move_emails tool — file messages into a named folder. A move is a wholesale
// replacement of the mailbox set (the whole RFC 8621 `mailboxIds` property,
// via emailSetMailboxes — a pointer patch can only add or drop the ids it
// names, never "and remove everything else"), which is what every JMAP
// client means by "move". Trash is refused here — by resolved id, so a
// localized trash-role folder cannot slip through, and by place name, so a
// role-less folder called "Trash" cannot either — so this tool can stay a
// non-destructive write; trash_emails carries that annotation.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { roleForPlaceName } from "../jmap/index.ts";

import { ACCOUNT_WRITE } from "./annotations.ts";
import {
	dedupedIds,
	type FileEmailsDeps,
	formatBatchResult,
	idsShape,
} from "./file-emails-common.ts";
import { errorResult, type ToolResult } from "./result.ts";

const moveEmailsShape = {
	...idsShape,
	mailbox: z
		.string()
		.min(1)
		.max(200)
		.describe(
			"Destination folder. The standard places — Inbox, Archive, Sent, Drafts, Junk — resolve to " +
				"the folder holding that role whatever the server calls it; any other value must match an " +
				"existing folder name exactly (case-insensitive). Folders are never created. Trash is not " +
				"accepted here: use trash_emails."
		),
};

export const moveEmailsInput = z.object({
	...moveEmailsShape,
	ids: dedupedIds,
});

export type MoveEmailsArgs = z.infer<typeof moveEmailsInput>;

export const moveEmails = async (
	deps: FileEmailsDeps,
	ctx: { args: MoveEmailsArgs; token: string }
): Promise<ToolResult> => {
	const { ids, mailbox } = ctx.args;
	const trashRefusal = errorResult(
		`Moving to ${mailbox} is a delete. Use trash_emails instead. Nothing was moved.`
	);
	if (roleForPlaceName(mailbox) === "trash") {
		return trashRefusal;
	}
	const lookup = await deps.resolveMailbox(ctx.token, mailbox);
	if (!lookup.id) {
		const available =
			lookup.available.length > 0
				? ` Available folders: ${lookup.available.join(", ")}.`
				: "";
		return errorResult(
			`Mailbox not found: ${mailbox}. Nothing was moved.${available}`
		);
	}
	const places = await deps.resolvePlaces(ctx.token);
	if (lookup.id === places.trash) {
		return trashRefusal;
	}
	const result = await deps.replaceMailboxes(ctx.token, ids, lookup.id);
	return formatBatchResult("Moved", result, ` to ${mailbox}`);
};

// --- MCP registration ----------------------------------------------------

export const registerMoveEmails = (
	server: McpServer,
	deps: FileEmailsDeps,
	getToken: () => string
): void => {
	server.registerTool(
		"move_emails",
		{
			annotations: ACCOUNT_WRITE,
			description:
				"Move one or more messages into a folder. They are removed from every folder they were in " +
				'and end up only in the destination. Use this when the user names a destination ("put this ' +
				'in Projects", "move it back to the inbox"). Takes message ids from search_emails or ' +
				"get_thread. The mailbox is resolved the same way as the search_emails mailbox filter and is " +
				"never created; an unknown name returns the folders that exist. Read state and flags (to-do, " +
				"starred) are untouched; use mark_emails to change them. Re-running it on the same " +
				"ids is harmless. To archive use archive_emails; to delete use trash_emails — this tool " +
				"refuses Trash. Reports how many messages moved and lists any id the server refused.",
			inputSchema: z.object(moveEmailsShape),
			title: "Move emails",
		},
		(args) =>
			moveEmails(deps, { args: moveEmailsInput.parse(args), token: getToken() })
	);
};
