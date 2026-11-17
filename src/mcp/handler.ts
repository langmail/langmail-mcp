// Builds the MCP server: its name, the per-tool logging, and the tool surface.
//
// `createRuntime` holds what lives as long as the process (the JMAP session
// cache, the credential, the signed-in principal); `createServer` registers
// the tools on a fresh `McpServer` against it. The stdio transport builds one
// server for the life of the process; a transport that serves many requests
// can build a server per request and share one runtime between them.

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { createTicketStore, type TicketStore } from "../attachments/tickets.ts";
import {
	createUploadTicketStore,
	type UploadTicketStore,
} from "../attachments/upload-tickets.ts";
import {
	type AccountTimeZoneResolver,
	makeAccountTimeZoneResolver,
} from "../caldav/account-settings.ts";
import type { Config } from "../config.ts";
import {
	createIdempotencyStore,
	type IdempotencyStore,
} from "../drafts/idempotency.ts";
import { createSendGuard, type SendGuard } from "../drafts/send-guard.ts";
import {
	createImageProxyStore,
	type ImageProxyStore,
} from "../email-render/image-proxy.ts";
import { registerEmailViewerResource } from "../email-render/viewer-resource.ts";
import {
	authorizationHeader,
	JmapError,
	type JmapLive,
	makeJmapLive,
} from "../jmap/index.ts";
import { makeLiveApplyIo, makeMailRulesApplier } from "../rules/apply.ts";
import { makeLiveSieveIo, makeMailRulesStore } from "../rules/store.ts";
import { registerArchiveEmails } from "../tools/archive-emails.ts";
import { makeLiveDeps as makeContactWriteDeps } from "../tools/contact-common.ts";
import { makeAttendeeWriteThrough } from "../tools/contact-write-through.ts";
import {
	makeLiveDeps as makeCreateCalendarDeps,
	registerCreateCalendar,
} from "../tools/create-calendar.ts";
import {
	makeLiveDeps as makeCreateCalendarEventDeps,
	registerCreateCalendarEvent,
} from "../tools/create-calendar-event.ts";
import { registerCreateContact } from "../tools/create-contact.ts";
import { registerCreateDraft } from "../tools/create-draft.ts";
import { registerCreateMailRule } from "../tools/create-mail-rule.ts";
import {
	makeLiveDeps as makeDeleteCalendarEventDeps,
	registerDeleteCalendarEvent,
} from "../tools/delete-calendar-event.ts";
import { registerDeleteContact } from "../tools/delete-contact.ts";
import { registerDeleteDraft } from "../tools/delete-draft.ts";
import { registerDeleteMailRule } from "../tools/delete-mail-rule.ts";
import {
	makeLiveDeps as makeDownloadAttachmentDeps,
	registerDownloadAttachment,
} from "../tools/download-attachment.ts";
import {
	makeLiveDeps as makeDownloadEmailDeps,
	registerDownloadEmail,
} from "../tools/download-email.ts";
import { makeLiveDeps as makeDraftDeps } from "../tools/draft-common.ts";
import { makeLiveDeps as makeFileEmailsDeps } from "../tools/file-emails-common.ts";
import { registerForwardMessage } from "../tools/forward-message.ts";
import { registerGetDraft } from "../tools/get-draft.ts";
import {
	makeLiveDeps as makeGetEmailDeps,
	registerGetEmail,
} from "../tools/get-email.ts";
import {
	makeLiveDeps as makeGetThreadDeps,
	registerGetThread,
} from "../tools/get-thread.ts";
import {
	makeLiveDeps as makeListCalendarEventsDeps,
	registerListCalendarEvents,
} from "../tools/list-calendar-events.ts";
import {
	makeLiveDeps as makeListCalendarsDeps,
	registerListCalendars,
} from "../tools/list-calendars.ts";
import { registerListDrafts } from "../tools/list-drafts.ts";
import { registerListMailRules } from "../tools/list-mail-rules.ts";
import { registerListUpcomingBirthdays } from "../tools/list-upcoming-birthdays.ts";
import type { MailRuleToolDeps } from "../tools/mail-rule-common.ts";
import { registerMarkEmails } from "../tools/mark-emails.ts";
import { registerMergeContacts } from "../tools/merge-contacts.ts";
import {
	makeLiveDeps as makeMoveCalendarEventsDeps,
	registerMoveCalendarEvents,
} from "../tools/move-calendar-events.ts";
import { registerMoveEmails } from "../tools/move-emails.ts";
import {
	makeLiveDeps as makePreviewEmailDeps,
	registerPreviewEmail,
} from "../tools/preview-email.ts";
import { registerPreviewMailRule } from "../tools/preview-mail-rule.ts";
import { registerReplyToMessage } from "../tools/reply-to-message.ts";
import {
	makeLiveDeps as makeRespondToEventDeps,
	registerRespondToEvent,
} from "../tools/respond-to-event.ts";
import {
	makeLiveDeps as makeSearchContactsDeps,
	registerSearchContacts,
} from "../tools/search-contacts.ts";
import {
	makeLiveDeps as makeSearchEmailsDeps,
	registerSearchEmails,
} from "../tools/search-emails.ts";
import { registerSendDraft } from "../tools/send-draft.ts";
import { registerTrashEmails } from "../tools/trash-emails.ts";
import {
	makeLiveDeps as makeUnsubscribeDeps,
	registerUnsubscribeFromList,
} from "../tools/unsubscribe-from-list.ts";
import {
	makeLiveDeps as makeUpdateCalendarDeps,
	registerUpdateCalendar,
} from "../tools/update-calendar.ts";
import {
	makeLiveDeps as makeUpdateCalendarEventDeps,
	registerUpdateCalendarEvent,
} from "../tools/update-calendar-event.ts";
import { registerUpdateContact } from "../tools/update-contact.ts";
import { registerUpdateDraft } from "../tools/update-draft.ts";
import { registerUpdateMailRule } from "../tools/update-mail-rule.ts";
import {
	makeLiveDeps as makeUploadAttachmentsDeps,
	registerUploadAttachments,
} from "../tools/upload-attachments.ts";
import { serverInstructions } from "./instructions.ts";
import { startLinkListener } from "./links.ts";
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
	// Answers of the composing tools, kept under the caller's `idempotencyKey`,
	// so a client that retries a call whose response it never saw gets the
	// first answer back instead of a second draft or a second delivery.
	composeReplays: IdempotencyStore<string>;
	// The mailbox address the credential signed in as. Tools that send mail
	// read it to pick the From identity. Only valid once `signIn` has resolved,
	// which the server guarantees before any tool runs.
	getPrincipal: () => string;
	// What every tool receives as its "token": the complete `Authorization`
	// header value for Stalwart. Tools pass it through `authorizationHeader`.
	getToken: () => string;
	// Image-proxy tokens: preview_email mints them, the `/image-proxy/<token>`
	// route redeems them by fetching the image from the sender's host. Only
	// there when the user has turned remote images on
	// (LANGMAIL_MCP_ALLOW_REMOTE_IMAGES); otherwise nothing mints a token and
	// no route serves one.
	imageTokens?: ImageProxyStore;
	// One JMAP session cache for every tool.
	jmapLive: JmapLive;
	// The base URL the file links handed to the agent are minted under, without
	// a trailing slash. A tool asks for it when it mints a link, never before.
	// HTTP transport: the public URL of the listener. stdio: the address of the
	// loopback link listener, which the first call starts — a stdio server
	// that never hands out a link opens no port.
	publicUrl: () => Promise<string>;
	// The account's time-zone preference (Stalwart's AccountSettings), cached
	// for a few minutes. One resolver, so every tool that needs "the user's
	// zone" shares one cache.
	resolveTimeZone: AccountTimeZoneResolver;
	// Reserves a draft while its send is in flight, so a retry that arrives
	// before the first call answers cannot deliver a second copy. Like
	// `composeReplays` it must outlive a request: the HTTP transport builds a
	// server per request, and a retry is a new request.
	sendGuard: SendGuard;
	// Resolves the JMAP session for the credential and learns the principal
	// from it. The first tool call pays for it; later calls reuse the answer.
	signIn: () => Promise<void>;
	stalwartUrl: string;
	// Download tickets: download_attachment and download_email mint them, the
	// `/attachments/<ticket>` route redeems them.
	tickets: TicketStore;
	// Upload tickets: upload_attachments mints them, the
	// `/attachments/uploads/<ticket>` route redeems them.
	uploadTickets: UploadTicketStore;
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

// Starts whatever serves a stdio runtime's file links and resolves with the
// base URL they live under.
export type StartLinks = (
	runtime: ServerRuntime,
	port: number | undefined
) => Promise<string>;

const startLoopbackLinks: StartLinks = async (runtime, port) =>
	(await startLinkListener(runtime, port)).origin;

export const createRuntime = (
	config: Config,
	jmapLive: JmapLive = makeJmapLive(config.stalwartUrl),
	startLinks: StartLinks = startLoopbackLinks
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

	const { transport } = config;
	let links: Promise<string> | undefined;
	const publicUrl = (): Promise<string> => {
		if (transport.kind === "http") {
			return Promise.resolve(transport.publicUrl);
		}
		if (links === undefined) {
			// One listener for the life of the process, however many tools ask
			// at once. A failed start is not kept: the next link tries again.
			const starting = startLinks(runtime, transport.linkPort);
			links = starting;
			starting.catch(() => {
				links = undefined;
			});
		}
		return links;
	};

	const runtime: ServerRuntime = {
		composeReplays: createIdempotencyStore<string>(),
		getPrincipal,
		getToken,
		...(config.allowRemoteImages
			? { imageTokens: createImageProxyStore() }
			: {}),
		jmapLive,
		publicUrl,
		resolveTimeZone: makeAccountTimeZoneResolver({
			serverUrl: config.stalwartUrl,
		}),
		sendGuard: createSendGuard(),
		signIn,
		stalwartUrl: config.stalwartUrl,
		tickets: createTicketStore(),
		uploadTickets: createUploadTicketStore(),
	};
	return runtime;
};

export const createServer = (
	config: Config,
	runtime: ServerRuntime = createRuntime(config)
): McpServer => {
	const server = new McpServer(
		{
			name: SERVER_NAME,
			version: readPackageVersion(),
		},
		{
			instructions: serverInstructions({
				allowUnsubscribePost: config.allowUnsubscribePost,
			}),
		}
	);
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
	// Shows one email through the MCP Apps viewer template registered below.
	// Its inline images are attachment links; remote images are proxied only
	// with the opt-in, and dropped without it.
	registerPreviewEmail(
		server,
		makePreviewEmailDeps(
			runtime.jmapLive,
			runtime.tickets,
			runtime.imageTokens,
			runtime.publicUrl
		),
		runtime.getToken
	);
	// The viewer may load images from this server's own address and nowhere
	// else. Over HTTP that address is configuration. Over stdio it is the
	// loopback link listener's, which does not exist yet: it is asked for when
	// a host reads the template, so listing tools and resources opens no port.
	registerEmailViewerResource(
		server,
		config.transport.kind === "http"
			? config.transport.publicUrl
			: runtime.publicUrl
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
	// Files move over links the agent fetches or PUTs to with curl: the tools
	// mint tickets, the `/attachments/` routes redeem them.
	registerDownloadAttachment(
		server,
		makeDownloadAttachmentDeps(
			runtime.jmapLive,
			runtime.tickets,
			runtime.publicUrl
		),
		runtime.getToken
	);
	registerDownloadEmail(
		server,
		makeDownloadEmailDeps(runtime.jmapLive, runtime.tickets, runtime.publicUrl),
		runtime.getToken
	);
	registerUploadAttachments(
		server,
		makeUploadAttachmentsDeps(
			runtime.jmapLive,
			runtime.uploadTickets,
			runtime.publicUrl
		),
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

	// CalDAV tools discover against the same Stalwart base; tsdav follows
	// /.well-known/caldav to /dav/cal. The credential goes out unchanged as the
	// Authorization header (the default of caldav/client.ts).
	const caldavCfg = { serverUrl: runtime.stalwartUrl };
	// Contact write-through: scheduling actions upsert their attendees into
	// the collected address book — shared across the three event tools so they
	// fold through one code path.
	const collectAttendees = makeAttendeeWriteThrough(runtime.jmapLive);
	registerListCalendars(
		server,
		makeListCalendarsDeps(caldavCfg),
		runtime.getToken
	);
	registerCreateCalendar(
		server,
		makeCreateCalendarDeps(caldavCfg),
		runtime.getToken
	);
	registerUpdateCalendar(
		server,
		makeUpdateCalendarDeps(caldavCfg),
		runtime.getToken
	);
	registerListCalendarEvents(
		server,
		makeListCalendarEventsDeps(caldavCfg),
		runtime.getToken
	);
	registerCreateCalendarEvent(
		server,
		makeCreateCalendarEventDeps(
			caldavCfg,
			runtime.resolveTimeZone,
			collectAttendees
		),
		runtime.getToken
	);
	registerUpdateCalendarEvent(
		server,
		makeUpdateCalendarEventDeps(
			caldavCfg,
			runtime.resolveTimeZone,
			collectAttendees
		),
		runtime.getToken
	);
	registerDeleteCalendarEvent(
		server,
		makeDeleteCalendarEventDeps(caldavCfg),
		runtime.getToken
	);
	registerMoveCalendarEvents(
		server,
		makeMoveCalendarEventsDeps(caldavCfg),
		runtime.getToken
	);
	registerRespondToEvent(
		server,
		makeRespondToEventDeps(caldavCfg, collectAttendees),
		runtime.getToken
	);

	const searchContactsDeps = makeSearchContactsDeps(
		runtime.jmapLive,
		caldavCfg
	);
	// The write side of the address book. Same JMAP session cache as the read
	// side; separate deps bundle because no writer hydrates subjects or titles.
	const contactWriteDeps = makeContactWriteDeps(runtime.jmapLive);
	registerSearchContacts(server, searchContactsDeps, runtime.getToken);
	// Reads through the write bundle (query + get) plus the account zone, so
	// "today" is the user's day.
	registerListUpcomingBirthdays(
		server,
		{ ...contactWriteDeps, resolveTimeZone: runtime.resolveTimeZone },
		runtime.getToken
	);
	registerCreateContact(server, contactWriteDeps, runtime.getToken);
	registerUpdateContact(server, contactWriteDeps, runtime.getToken);
	registerDeleteContact(server, contactWriteDeps, runtime.getToken);
	// Writes through the write bundle, then renders the result with the read
	// side's subject and title lookups.
	registerMergeContacts(
		server,
		{ ...searchContactsDeps, ...contactWriteDeps },
		runtime.getToken
	);

	// Drafts and sending: one deps bundle for the whole surface. The replay
	// cache and the send guard come from the runtime, so they hold across the
	// servers an HTTP listener builds per request.
	const draftDeps = makeDraftDeps(runtime.jmapLive);
	registerCreateDraft(
		server,
		draftDeps,
		runtime.composeReplays,
		runtime.getToken,
		runtime.getPrincipal
	);
	registerGetDraft(server, draftDeps, runtime.getToken);
	registerListDrafts(server, draftDeps, runtime.getToken);
	registerUpdateDraft(
		server,
		draftDeps,
		runtime.getToken,
		runtime.getPrincipal
	);
	registerSendDraft(
		server,
		draftDeps,
		runtime.composeReplays,
		runtime.sendGuard,
		runtime.getToken,
		runtime.getPrincipal
	);
	registerDeleteDraft(
		server,
		draftDeps,
		runtime.sendGuard,
		runtime.getToken,
		runtime.getPrincipal
	);
	registerReplyToMessage(
		server,
		draftDeps,
		runtime.composeReplays,
		runtime.sendGuard,
		runtime.getToken,
		runtime.getPrincipal
	);
	registerForwardMessage(
		server,
		draftDeps,
		runtime.composeReplays,
		runtime.sendGuard,
		runtime.getToken,
		runtime.getPrincipal
	);

	return server;
};
