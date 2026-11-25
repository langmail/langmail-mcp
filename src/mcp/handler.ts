// Per-request MCP handler.
//
// Stateless mode: each authenticated request to /mcp creates a fresh
// McpServer + WebStandardStreamableHTTPServerTransport pair, registers
// the tool surface, and hands the Request to the transport. The
// per-request cost is modest (no DB connections to open; the JMAP
// session lookup is cached across requests via `makeLiveDeps`), and
// avoiding shared session state simplifies reasoning about token
// revocation — a 401 from /auth/userinfo is the only thing that gates
// access, and it runs before we get here.

import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'

// The released version: semantic-release bumps package.json, the hosted image
// copies it, and scripts/build-package.ts inlines it into the npm bundle.
import { version } from '../../package.json' with { type: 'json' }
import { type RecordAgentActivity } from '../activity/record-agent-activity.ts'
import { type TicketStore } from '../attachments/tickets.ts'
import { type UploadTicketStore } from '../attachments/upload-tickets.ts'
import { type AuthContext } from '../auth/middleware.ts'
import { makeAccountTimeZoneResolver } from '../caldav/account-settings.ts'
import { type CalendarShareStore } from '../calendar-feeds/shares.ts'
import { createIdempotencyStore } from '../drafts/idempotency.ts'
import { createSendGuard } from '../drafts/send-guard.ts'
import { type ImageProxyStore } from '../email-render/image-proxy.ts'
import { registerEmailViewerResource } from '../email-render/viewer-resource.ts'
import { type JmapLive } from '../jmap/index.ts'
import { type ServerMode } from '../mode.ts'
import { makeLiveApplyIo, makeMailRulesApplier } from '../rules/apply.ts'
import { makeLiveSieveIo, makeMailRulesStore } from '../rules/store.ts'
import { registerArchiveEmails } from '../tools/archive-emails.ts'
import { makeLiveCalendarSharingDeps } from '../tools/calendar-share-common.ts'
import { makeLiveDeps as makeContactWriteDeps } from '../tools/contact-common.ts'
import { makeAttendeeWriteThrough } from '../tools/contact-write-through.ts'
import { makeLiveDeps as makeCreateCalendarDeps, registerCreateCalendar } from '../tools/create-calendar.ts'
import {
  makeLiveDeps as makeCreateCalendarEventDeps,
  registerCreateCalendarEvent,
} from '../tools/create-calendar-event.ts'
import { registerCreateContact } from '../tools/create-contact.ts'
import { registerCreateDraft } from '../tools/create-draft.ts'
import { registerCreateMailRule } from '../tools/create-mail-rule.ts'
import {
  makeLiveDeps as makeDeleteCalendarEventDeps,
  registerDeleteCalendarEvent,
} from '../tools/delete-calendar-event.ts'
import { registerDeleteContact } from '../tools/delete-contact.ts'
import { registerDeleteDraft } from '../tools/delete-draft.ts'
import { registerDeleteMailRule } from '../tools/delete-mail-rule.ts'
import { makeLiveDeps as makeDownloadAttachmentDeps, registerDownloadAttachment } from '../tools/download-attachment.ts'
import { makeLiveDeps as makeDownloadEmailDeps, registerDownloadEmail } from '../tools/download-email.ts'
import { makeLiveDeps as makeDraftDeps } from '../tools/draft-common.ts'
import { makeLiveDeps as makeFileEmailsDeps } from '../tools/file-emails-common.ts'
import { registerForwardMessage } from '../tools/forward-message.ts'
import { registerGetDraft } from '../tools/get-draft.ts'
import { makeLiveDeps as makeGetEmailDeps, registerGetEmail } from '../tools/get-email.ts'
import { makeLiveDeps as makeGetThreadDeps, registerGetThread } from '../tools/get-thread.ts'
import {
  makeLiveDeps as makeListCalendarEventsDeps,
  registerListCalendarEvents,
} from '../tools/list-calendar-events.ts'
import { registerListCalendars } from '../tools/list-calendars.ts'
import { registerListDrafts } from '../tools/list-drafts.ts'
import { registerListMailRules } from '../tools/list-mail-rules.ts'
import { registerListUpcomingBirthdays } from '../tools/list-upcoming-birthdays.ts'
import { type MailRuleToolDeps } from '../tools/mail-rule-common.ts'
import { registerMarkEmails } from '../tools/mark-emails.ts'
import { registerMergeContacts } from '../tools/merge-contacts.ts'
import {
  makeLiveDeps as makeMoveCalendarEventsDeps,
  registerMoveCalendarEvents,
} from '../tools/move-calendar-events.ts'
import { registerMoveEmails } from '../tools/move-emails.ts'
import { makeLiveDeps as makePreviewEmailDeps, registerPreviewEmail } from '../tools/preview-email.ts'
import { registerPreviewMailRule } from '../tools/preview-mail-rule.ts'
import { registerReplyToMessage } from '../tools/reply-to-message.ts'
import { makeLiveDeps as makeRespondToEventDeps, registerRespondToEvent } from '../tools/respond-to-event.ts'
import { makeLiveDeps as makeSearchContactsDeps, registerSearchContacts } from '../tools/search-contacts.ts'
import { makeLiveDeps as makeSearchEmailsDeps, registerSearchEmails } from '../tools/search-emails.ts'
import { registerSendDraft } from '../tools/send-draft.ts'
import { registerShareCalendar } from '../tools/share-calendar.ts'
import { registerStopSharingCalendar } from '../tools/stop-sharing-calendar.ts'
import { registerTrashEmails } from '../tools/trash-emails.ts'
import { makeLiveDeps as makeUnsubscribeDeps, registerUnsubscribeFromList } from '../tools/unsubscribe-from-list.ts'
import { makeLiveDeps as makeUpdateCalendarDeps, registerUpdateCalendar } from '../tools/update-calendar.ts'
import {
  makeLiveDeps as makeUpdateCalendarEventDeps,
  registerUpdateCalendarEvent,
} from '../tools/update-calendar-event.ts'
import { registerUpdateContact } from '../tools/update-contact.ts'
import { registerUpdateDraft } from '../tools/update-draft.ts'
import { registerUpdateMailRule } from '../tools/update-mail-rule.ts'
import { makeLiveDeps as makeUploadAttachmentsDeps, registerUploadAttachments } from '../tools/upload-attachments.ts'
import { SELF_HOSTED_INSTRUCTIONS, SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_WITHOUT_SHARING } from './instructions.ts'
import { instrumentToolLogging } from './tool-logging.ts'

export interface McpHandlerConfig {
  // The calendar shares share_calendar, stop_sharing_calendar and
  // list_calendars work on; undefined without Auth's internal endpoints,
  // which leaves the two sharing tools out.
  calendarShares?: CalendarShareStore
  // Shared with the /image-proxy/:token route: preview_email mints, the
  // route redeems.
  imageTokens: ImageProxyStore
  // Shared with the /attachments/:token route (handler.ts) so a bearer's
  // JMAP session is resolved once, not once per surface.
  live: JmapLive
  // Hosted when left out. Self-hosted (src/self-hosted/) leaves out calendar
  // sharing, the agent-activity record and the attendee write-through into a
  // Collected address book, and words search_emails and the contact tools for
  // mail nobody classified (see mode.ts).
  mode?: ServerMode
  // Base URL the download_attachment tool mints links under.
  publicUrl: string
  // Called after each successful tool call, with the caller's user id.
  // Ignored in self-hosted mode, which records no activity.
  recordAgentActivity: RecordAgentActivity
  stalwartUrl: string
  // Shared with the /attachments/:token route: the tool mints, the route redeems.
  tickets: TicketStore
  // Shared with the /attachments/uploads/:token route: upload_attachments
  // mints, the route redeems.
  uploadTickets: UploadTicketStore
}

// The credential and identity one MCP server acts with: the hosted server
// builds it per request from the validated bearer (AuthContext); the
// self-hosted one builds it once from its settings.
export type ServerContext = Pick<AuthContext, 'principal' | 'token' | 'userId'>

// Builds a fresh McpServer with the whole tool surface for one context. The
// deps behind it (JMAP session cache, replay cache, send guard) are built once
// and shared by every server the factory makes.
export const createMcpServerFactory = (cfg: McpHandlerConfig): ((ctx: ServerContext) => McpServer) => {
  const mode = cfg.mode ?? 'hosted'
  const selfHosted = mode === 'self-hosted'
  const calendarShares = selfHosted ? undefined : cfg.calendarShares
  const recordAgentActivity: RecordAgentActivity = selfHosted ? () => Promise.resolve() : cfg.recordAgentActivity
  const jmapLive = cfg.live
  const searchEmailsDeps = makeSearchEmailsDeps(jmapLive)
  const getEmailDeps = makeGetEmailDeps(jmapLive)
  const getThreadDeps = makeGetThreadDeps(jmapLive)
  // Filing: archive/move/trash share one deps bundle and the request-cycle
  // JMAP session cache.
  const fileEmailsDeps = makeFileEmailsDeps(jmapLive)
  const downloadAttachmentDeps = makeDownloadAttachmentDeps(jmapLive, cfg.tickets, cfg.publicUrl)
  const downloadEmailDeps = makeDownloadEmailDeps(jmapLive, cfg.tickets, cfg.publicUrl)
  const uploadAttachmentsDeps = makeUploadAttachmentsDeps(jmapLive, cfg.uploadTickets, cfg.publicUrl)
  const unsubscribeDeps = makeUnsubscribeDeps(jmapLive)
  const previewEmailDeps = makePreviewEmailDeps(jmapLive, cfg.tickets, cfg.imageTokens, cfg.publicUrl)
  // CalDAV tools discover against the same Stalwart base; tsdav follows
  // /.well-known/caldav to /dav/cal.
  const caldavCfg = { serverUrl: cfg.stalwartUrl }
  // One resolver (one per-token zone cache) shared by create + update, so a
  // create→update in quick succession reuses the cached AccountSettings read
  // instead of paying the JMAP round-trip twice.
  const resolveTimeZone = makeAccountTimeZoneResolver({ serverUrl: cfg.stalwartUrl })
  // Mail rules persist as one managed Sieve script in the user's Stalwart
  // account; the existing-mail applier runs the explicit backfills. Both
  // share the request-cycle JMAP session cache.
  const mailRuleDeps: MailRuleToolDeps = {
    applier: makeMailRulesApplier(makeLiveApplyIo(jmapLive)),
    store: makeMailRulesStore(makeLiveSieveIo(jmapLive)),
  }
  // list_calendars and the two sharing tools: the calendars over CalDAV, the
  // shares through Auth, and the base URL a share's link is minted under.
  const calendarSharingDeps = makeLiveCalendarSharingDeps(caldavCfg, cfg.publicUrl, calendarShares)
  const createCalendarDeps = makeCreateCalendarDeps(caldavCfg)
  const updateCalendarDeps = makeUpdateCalendarDeps(caldavCfg)
  const listCalendarEventsDeps = makeListCalendarEventsDeps(caldavCfg)
  // Contact write-through: scheduling actions upsert their attendees into
  // the collected address book (the Robin case) — shared across the three
  // event tools so they fold through one code path. Off self-hosted: it would
  // create a "Collected" book in someone's own Stalwart that their phone then
  // syncs.
  const collectAttendees = selfHosted ? undefined : makeAttendeeWriteThrough(jmapLive)
  const createCalendarEventDeps = makeCreateCalendarEventDeps(caldavCfg, resolveTimeZone, collectAttendees)
  const updateCalendarEventDeps = makeUpdateCalendarEventDeps(caldavCfg, resolveTimeZone, collectAttendees)
  const deleteCalendarEventDeps = makeDeleteCalendarEventDeps(caldavCfg)
  const moveCalendarEventsDeps = makeMoveCalendarEventsDeps(caldavCfg)
  const respondToEventDeps = makeRespondToEventDeps(caldavCfg, collectAttendees)
  const searchContactsDeps = makeSearchContactsDeps(jmapLive, caldavCfg)
  // The write side of the address book. Same JMAP session cache as the read
  // side; separate deps bundle because no writer hydrates subjects or titles.
  const contactWriteDeps = makeContactWriteDeps(jmapLive)
  // Composition: one deps bundle for the whole draft/send surface (they share
  // every seam), plus one process-lifetime replay cache so a client that
  // retries a send whose response it never saw gets the first answer back
  // instead of a second delivery.
  const draftDeps = makeDraftDeps(jmapLive)
  const composeReplays = createIdempotencyStore<string>()
  // Reserves a draft while its send is in flight, so a client that retries
  // before the first call answers can't deliver a second copy.
  const sendGuard = createSendGuard()

  let instructions = SERVER_INSTRUCTIONS_WITHOUT_SHARING
  if (selfHosted) {
    instructions = SELF_HOSTED_INSTRUCTIONS
  } else if (calendarShares) {
    instructions = SERVER_INSTRUCTIONS
  }

  return (ctx) => {
    const server = new McpServer(
      {
        name: 'langmail-mcp',
        version,
      },
      { instructions }
    )
    // Before any registerTool call — the wrapper only covers later registrations.
    instrumentToolLogging(server, () => recordAgentActivity(ctx.userId))
    registerSearchEmails(server, searchEmailsDeps, () => ctx.token, mode)
    registerGetEmail(server, getEmailDeps, () => ctx.token)
    registerPreviewEmail(server, previewEmailDeps, () => ctx.token)
    // The tool's UI template (SEP-1865). Registering it also turns on the
    // `resources` capability for this per-request server.
    registerEmailViewerResource(server, cfg.publicUrl)
    registerGetThread(server, getThreadDeps, () => ctx.token)
    registerArchiveEmails(server, fileEmailsDeps, () => ctx.token)
    registerMoveEmails(server, fileEmailsDeps, () => ctx.token)
    registerTrashEmails(server, fileEmailsDeps, () => ctx.token)
    registerMarkEmails(server, fileEmailsDeps, () => ctx.token)
    registerUnsubscribeFromList(server, unsubscribeDeps, () => ctx.token)
    registerDownloadAttachment(server, downloadAttachmentDeps, () => ctx.token)
    registerDownloadEmail(server, downloadEmailDeps, () => ctx.token)
    registerUploadAttachments(server, uploadAttachmentsDeps, () => ctx.token)
    registerPreviewMailRule(server, mailRuleDeps, () => ctx.token)
    registerCreateMailRule(server, mailRuleDeps, () => ctx.token)
    registerListMailRules(server, mailRuleDeps, () => ctx.token)
    registerUpdateMailRule(server, mailRuleDeps, () => ctx.token)
    registerDeleteMailRule(server, mailRuleDeps, () => ctx.token)
    registerListCalendars(
      server,
      calendarSharingDeps,
      () => ctx.token,
      () => ctx.userId
    )
    if (calendarShares) {
      registerShareCalendar(
        server,
        calendarSharingDeps,
        () => ctx.token,
        () => ctx.userId
      )
      registerStopSharingCalendar(
        server,
        calendarSharingDeps,
        () => ctx.token,
        () => ctx.userId
      )
    }
    registerCreateCalendar(server, createCalendarDeps, () => ctx.token)
    registerUpdateCalendar(server, updateCalendarDeps, () => ctx.token)
    registerListCalendarEvents(server, listCalendarEventsDeps, () => ctx.token)
    registerCreateCalendarEvent(server, createCalendarEventDeps, () => ctx.token)
    registerUpdateCalendarEvent(server, updateCalendarEventDeps, () => ctx.token)
    registerDeleteCalendarEvent(server, deleteCalendarEventDeps, () => ctx.token)
    registerMoveCalendarEvents(server, moveCalendarEventsDeps, () => ctx.token)
    registerRespondToEvent(server, respondToEventDeps, () => ctx.token)
    registerSearchContacts(server, searchContactsDeps, () => ctx.token, mode)
    // Reads through the write bundle (query + get) plus the account zone the
    // calendar tools share, so "today" is the user's day.
    registerListUpcomingBirthdays(server, { ...contactWriteDeps, resolveTimeZone }, () => ctx.token)
    registerCreateContact(server, contactWriteDeps, () => ctx.token, mode)
    registerUpdateContact(server, contactWriteDeps, () => ctx.token)
    registerDeleteContact(server, contactWriteDeps, () => ctx.token, mode)
    // Writes through the write bundle, then renders the result with the read
    // side's subject and title lookups.
    registerMergeContacts(server, { ...searchContactsDeps, ...contactWriteDeps }, () => ctx.token, mode)
    registerCreateDraft(
      server,
      draftDeps,
      composeReplays,
      () => ctx.token,
      () => ctx.principal
    )
    registerGetDraft(server, draftDeps, () => ctx.token)
    registerListDrafts(server, draftDeps, () => ctx.token)
    registerUpdateDraft(
      server,
      draftDeps,
      () => ctx.token,
      () => ctx.principal
    )
    registerSendDraft(
      server,
      draftDeps,
      composeReplays,
      sendGuard,
      () => ctx.token,
      () => ctx.principal
    )
    registerDeleteDraft(
      server,
      draftDeps,
      sendGuard,
      () => ctx.token,
      () => ctx.principal
    )
    registerReplyToMessage(
      server,
      draftDeps,
      composeReplays,
      sendGuard,
      () => ctx.token,
      () => ctx.principal
    )
    registerForwardMessage(
      server,
      draftDeps,
      composeReplays,
      sendGuard,
      () => ctx.token,
      () => ctx.principal
    )
    return server
  }
}

export const createMcpHandler = (cfg: McpHandlerConfig): ((req: Request, ctx: AuthContext) => Promise<Response>) => {
  const buildServer = createMcpServerFactory(cfg)
  return async (req, ctx) => {
    const server = buildServer(ctx)

    // Stateless mode (sessionIdGenerator omitted). Each request stands
    // alone — initialize, tool call, and shutdown happen within the
    // same HTTP exchange. Avoids needing a per-session transport map.
    const transport = new WebStandardStreamableHTTPServerTransport()
    await server.connect(transport)

    return transport.handleRequest(req, {
      authInfo: {
        clientId: 'langmail-mcp',
        extra: { principal: ctx.principal },
        scopes: [],
        token: ctx.token,
      },
    })
  }
}
