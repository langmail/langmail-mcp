// Builds the MCP server: its name, the per-tool logging, and the tool surface.
//
// `createRuntime` holds what lives as long as the process (the JMAP session
// cache, the credential, the signed-in principal); `createServer` registers
// the tools on a fresh `McpServer` against it. The stdio transport builds one
// server for the life of the process; a transport that serves many requests
// can build a server per request and share one runtime between them.

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "../config.ts";
import {
	authorizationHeader,
	JmapError,
	type JmapLive,
	makeJmapLive,
} from "../jmap/index.ts";
import { makeLiveApplyIo, makeMailRulesApplier } from "../rules/apply.ts";
import { makeLiveSieveIo, makeMailRulesStore } from "../rules/store.ts";
import { registerArchiveEmails } from "../tools/archive-emails.ts";
import { registerCreateMailRule } from "../tools/create-mail-rule.ts";
import { registerDeleteMailRule } from "../tools/delete-mail-rule.ts";
import { makeLiveDeps as makeFileEmailsDeps } from "../tools/file-emails-common.ts";
import {
	makeLiveDeps as makeGetEmailDeps,
	registerGetEmail,
} from "../tools/get-email.ts";
import {
	makeLiveDeps as makeGetThreadDeps,
	registerGetThread,
} from "../tools/get-thread.ts";
import { registerListMailRules } from "../tools/list-mail-rules.ts";
import type { MailRuleToolDeps } from "../tools/mail-rule-common.ts";
import { registerMarkEmails } from "../tools/mark-emails.ts";
import { registerMoveEmails } from "../tools/move-emails.ts";
import { registerPreviewMailRule } from "../tools/preview-mail-rule.ts";
import {
	makeLiveDeps as makeSearchEmailsDeps,
	registerSearchEmails,
} from "../tools/search-emails.ts";
import { registerTrashEmails } from "../tools/trash-emails.ts";
import {
	makeLiveDeps as makeUnsubscribeDeps,
	registerUnsubscribeFromList,
} from "../tools/unsubscribe-from-list.ts";
import { registerUpdateMailRule } from "../tools/update-mail-rule.ts";
import { instrumentToolLogging } from "./tool-logging.ts";

export const SERVER_NAME = "langmail-mcp";

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** The package version, read from the `package.json` that ships next to `dist/`. */
export const readPackageVersion = (): string => {
	const raw = readFileSync(
		new URL("../../package.json", import.meta.url),
		"utf8"
	);
	const { version } = JSON.parse(raw) as { version: string };
	return version;
};

export interface ServerRuntime {
	// The mailbox address the credential signed in as. Tools that send mail
	// read it to pick the From identity. Only valid once `signIn` has resolved,
	// which the server guarantees before any tool runs.
	getPrincipal: () => string;
	// What every tool receives as its "token": the complete `Authorization`
	// header value for Stalwart. Tools pass it through `authorizationHeader`.
	getToken: () => string;
	// One JMAP session cache for every tool.
	jmapLive: JmapLive;
	// Resolves the JMAP session for the credential and learns the principal
	// from it. The first tool call pays for it; later calls reuse the answer.
	signIn: () => Promise<void>;
	stalwartUrl: string;
}

const signInFailure = (stalwartUrl: string, error: unknown): Error => {
	if (
		error instanceof JmapError &&
		(error.status === HTTP_UNAUTHORIZED || error.status === HTTP_FORBIDDEN)
	) {
		return new Error(
			`Stalwart at ${stalwartUrl} rejected the credential (HTTP ${error.status}). Check STALWART_USERNAME and STALWART_PASSWORD (an app password), or STALWART_TOKEN, in this server's configuration.`,
			{ cause: error }
		);
	}
	if (error instanceof JmapError) {
		return new Error(
			`Stalwart at ${stalwartUrl} did not answer the JMAP session request as expected (${error.message}). Check that STALWART_URL is the base URL of a Stalwart server.`,
			{ cause: error }
		);
	}
	return new Error(
		`Could not reach Stalwart at ${stalwartUrl}. Check STALWART_URL and that the server is up.`,
		{ cause: error }
	);
};

export const createRuntime = (
	config: Config,
	jmapLive: JmapLive = makeJmapLive(config.stalwartUrl)
): ServerRuntime => {
	const getToken = (): string => config.credential;
	let principal: string | undefined;

	const signIn = async (): Promise<void> => {
		if (principal !== undefined) {
			return;
		}
		// Nothing is cached on failure: the next tool call tries again, so a
		// server that was down at the first call needs no restart.
		let username: string | undefined;
		try {
			({ username } = await jmapLive.getSession(
				authorizationHeader(getToken())
			));
		} catch (error) {
			throw signInFailure(config.stalwartUrl, error);
		}
		if (username === undefined) {
			throw new Error(
				`Stalwart at ${config.stalwartUrl} answered without naming an account, so the credential was not accepted. Check STALWART_USERNAME and STALWART_PASSWORD (an app password), or STALWART_TOKEN, in this server's configuration.`
			);
		}
		principal = username;
	};

	const getPrincipal = (): string => {
		if (principal === undefined) {
			throw new Error("the principal was read before signing in to Stalwart");
		}
		return principal;
	};

	return {
		getPrincipal,
		getToken,
		jmapLive,
		signIn,
		stalwartUrl: config.stalwartUrl,
	};
};

export const createServer = (
	config: Config,
	runtime: ServerRuntime = createRuntime(config)
): McpServer => {
	const server = new McpServer({
		name: SERVER_NAME,
		version: readPackageVersion(),
	});
	// Before any registerTool call — the wrapper only covers later
	// registrations. It also signs in ahead of every tool, so a tool finds the
	// principal known and a bad credential is reported the same way everywhere.
	instrumentToolLogging(server, runtime.signIn);

	// Tools are registered here, one line each, in the order the hosted server
	// lists them. A tool takes its dependencies, then the credential, then (if
	// it sends mail) the principal:
	//   registerGetEmail(server, makeGetEmailDeps(runtime.jmapLive), runtime.getToken)
	//   registerSendDraft(server, …, runtime.getToken, runtime.getPrincipal)
	registerSearchEmails(
		server,
		makeSearchEmailsDeps(runtime.jmapLive),
		runtime.getToken
	);
	registerGetEmail(
		server,
		makeGetEmailDeps(runtime.jmapLive),
		runtime.getToken
	);
	registerGetThread(
		server,
		makeGetThreadDeps(runtime.jmapLive),
		runtime.getToken
	);

	// Filing: archive/move/trash/mark share one deps bundle.
	const fileEmailsDeps = makeFileEmailsDeps(runtime.jmapLive);
	registerArchiveEmails(server, fileEmailsDeps, runtime.getToken);
	registerMoveEmails(server, fileEmailsDeps, runtime.getToken);
	registerTrashEmails(server, fileEmailsDeps, runtime.getToken);
	registerMarkEmails(server, fileEmailsDeps, runtime.getToken);
	// The one-click POST goes to a host the sender chose: only with the opt-in.
	registerUnsubscribeFromList(
		server,
		makeUnsubscribeDeps(runtime.jmapLive, {
			allowOneClickPost: config.allowUnsubscribePost,
		}),
		runtime.getToken
	);

	const mailRuleDeps: MailRuleToolDeps = {
		applier: makeMailRulesApplier(makeLiveApplyIo(runtime.jmapLive)),
		store: makeMailRulesStore(makeLiveSieveIo(runtime.jmapLive)),
	};
	registerPreviewMailRule(server, mailRuleDeps, runtime.getToken);
	registerCreateMailRule(server, mailRuleDeps, runtime.getToken);
	registerListMailRules(server, mailRuleDeps, runtime.getToken);
	registerUpdateMailRule(server, mailRuleDeps, runtime.getToken);
	registerDeleteMailRule(server, mailRuleDeps, runtime.getToken);

	return server;
};
