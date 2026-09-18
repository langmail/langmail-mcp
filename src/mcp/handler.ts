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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import { type JmapLive } from '@langmail/jmap'

import { type TicketStore } from '../attachments/tickets.ts'
import { type AuthContext } from '../auth/middleware.ts'
import { makeAccountTimeZoneResolver } from '../caldav/account-settings.ts'
import { createIdempotencyStore } from '../drafts/idempotency.ts'
import { createSendGuard } from '../drafts/send-guard.ts'
import { type ImageProxyStore } from '../email-render/image-proxy.ts'
import { registerEmailViewerResource } from '../email-render/viewer-resource.ts'
import { makeLiveApplyIo, makeMailRulesApplier } from '../rules/apply.ts'
import { makeLiveSieveIo, makeMailRulesStore } from '../rules/store.ts'
import { registerArchiveEmails } from '../tools/archive-emails.ts'
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
import { registerDeleteMailRule } from '../tools/delete-mail-rule.ts'
import { makeLiveDeps as makeDownloadAttachmentDeps, registerDownloadAttachment } from '../tools/download-attachment.ts'
import { makeLiveDeps as makeDraftDeps } from '../tools/draft-common.ts'
import { makeLiveDeps as makeFileEmailsDeps } from '../tools/file-emails-common.ts'
import { registerGetDraft } from '../tools/get-draft.ts'
import { makeLiveDeps as makeGetEmailDeps, registerGetEmail } from '../tools/get-email.ts'
import { makeLiveDeps as makeGetThreadDeps, registerGetThread } from '../tools/get-thread.ts'
import {
  makeLiveDeps as makeListCalendarEventsDeps,
  registerListCalendarEvents,
} from '../tools/list-calendar-events.ts'
import { makeLiveDeps as makeListCalendarsDeps, registerListCalendars } from '../tools/list-calendars.ts'
import { registerListMailRules } from '../tools/list-mail-rules.ts'
import { registerListUpcomingBirthdays } from '../tools/list-upcoming-birthdays.ts'
import { type MailRuleToolDeps } from '../tools/mail-rule-common.ts'
import { registerMoveEmails } from '../tools/move-emails.ts'
import { makeLiveDeps as makePreviewEmailDeps, registerPreviewEmail } from '../tools/preview-email.ts'
import { registerPreviewMailRule } from '../tools/preview-mail-rule.ts'
import { registerReplyToMessage } from '../tools/reply-to-message.ts'
import { makeLiveDeps as makeRespondToEventDeps, registerRespondToEvent } from '../tools/respond-to-event.ts'
import { makeLiveDeps as makeSearchContactsDeps, registerSearchContacts } from '../tools/search-contacts.ts'
import { makeLiveDeps as makeSearchEmailsDeps, registerSearchEmails } from '../tools/search-emails.ts'
import { registerSendDraft } from '../tools/send-draft.ts'
import { registerTrashEmails } from '../tools/trash-emails.ts'
import {
  makeLiveDeps as makeUpdateCalendarEventDeps,
  registerUpdateCalendarEvent,
} from '../tools/update-calendar-event.ts'
import { registerUpdateContact } from '../tools/update-contact.ts'
import { registerUpdateDraft } from '../tools/update-draft.ts'
import { registerUpdateMailRule } from '../tools/update-mail-rule.ts'
import { instrumentToolLogging } from './tool-logging.ts'

export interface McpHandlerConfig {
  // Shared with the /image-proxy/:token route: preview_email mints, the
  // route redeems.
  imageTokens: ImageProxyStore
  // Shared with the /attachments/:token route (handler.ts) so a bearer's
  // JMAP session is resolved once, not once per surface.
  live: JmapLive
  // Base URL the download_attachment tool mints links under.
  publicUrl: string
  stalwartUrl: string
  // Shared with the /attachments/:token route: the tool mints, the route redeems.
  tickets: TicketStore
}

export const createMcpHandler = (cfg: McpHandlerConfig): ((req: Request, ctx: AuthContext) => Promise<Response>) => {
  const jmapLive = cfg.live
  const searchEmailsDeps = makeSearchEmailsDeps(jmapLive)
  const getEmailDeps = makeGetEmailDeps(jmapLive)
  const getThreadDeps = makeGetThreadDeps(jmapLive)
  // Filing: archive/move/trash share one deps bundle and the request-cycle
  // JMAP session cache.
  const fileEmailsDeps = makeFileEmailsDeps(jmapLive)
  const downloadAttachmentDeps = makeDownloadAttachmentDeps(jmapLive, cfg.tickets, cfg.publicUrl)
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
  const listCalendarsDeps = makeListCalendarsDeps(caldavCfg)
  const createCalendarDeps = makeCreateCalendarDeps(caldavCfg)
  const listCalendarEventsDeps = makeListCalendarEventsDeps(caldavCfg)
  // Contact write-through: scheduling actions upsert their attendees into
  // the collected address book (the Robin case) — shared across the three
  // event tools so they fold through one code path.
  const collectAttendees = makeAttendeeWriteThrough(jmapLive)
  const createCalendarEventDeps = makeCreateCalendarEventDeps(caldavCfg, resolveTimeZone, collectAttendees)
  const updateCalendarEventDeps = makeUpdateCalendarEventDeps(caldavCfg, resolveTimeZone, collectAttendees)
  const deleteCalendarEventDeps = makeDeleteCalendarEventDeps(caldavCfg)
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

  return async (req, ctx) => {
    const server = new McpServer({
      name: 'langmail-mcp',
      version: '0.1.0',
    })
    // Before any registerTool call — the wrapper only covers later registrations.
    instrumentToolLogging(server)
    registerSearchEmails(server, searchEmailsDeps, () => ctx.token)
    registerGetEmail(server, getEmailDeps, () => ctx.token)
    registerPreviewEmail(server, previewEmailDeps, () => ctx.token)
    // The tool's UI template (SEP-1865). Registering it also turns on the
    // `resources` capability for this per-request server.
    registerEmailViewerResource(server, cfg.publicUrl)
    registerGetThread(server, getThreadDeps, () => ctx.token)
    registerArchiveEmails(server, fileEmailsDeps, () => ctx.token)
    registerMoveEmails(server, fileEmailsDeps, () => ctx.token)
    registerTrashEmails(server, fileEmailsDeps, () => ctx.token)
    registerDownloadAttachment(server, downloadAttachmentDeps, () => ctx.token)
    registerPreviewMailRule(server, mailRuleDeps, () => ctx.token)
    registerCreateMailRule(server, mailRuleDeps, () => ctx.token)
    registerListMailRules(server, mailRuleDeps, () => ctx.token)
    registerUpdateMailRule(server, mailRuleDeps, () => ctx.token)
    registerDeleteMailRule(server, mailRuleDeps, () => ctx.token)
    registerListCalendars(server, listCalendarsDeps, () => ctx.token)
    registerCreateCalendar(server, createCalendarDeps, () => ctx.token)
    registerListCalendarEvents(server, listCalendarEventsDeps, () => ctx.token)
    registerCreateCalendarEvent(server, createCalendarEventDeps, () => ctx.token)
    registerUpdateCalendarEvent(server, updateCalendarEventDeps, () => ctx.token)
    registerDeleteCalendarEvent(server, deleteCalendarEventDeps, () => ctx.token)
    registerRespondToEvent(server, respondToEventDeps, () => ctx.token)
    registerSearchContacts(server, searchContactsDeps, () => ctx.token)
    // Reads through the write bundle (query + get) plus the account zone the
    // calendar tools share, so "today" is the user's day.
    registerListUpcomingBirthdays(server, { ...contactWriteDeps, resolveTimeZone }, () => ctx.token)
    registerCreateContact(server, contactWriteDeps, () => ctx.token)
    registerUpdateContact(server, contactWriteDeps, () => ctx.token)
    registerDeleteContact(server, contactWriteDeps, () => ctx.token)
    registerCreateDraft(
      server,
      draftDeps,
      composeReplays,
      () => ctx.token,
      () => ctx.principal
    )
    registerGetDraft(server, draftDeps, () => ctx.token)
    registerUpdateDraft(server, draftDeps, () => ctx.token)
    registerSendDraft(
      server,
      draftDeps,
      composeReplays,
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
