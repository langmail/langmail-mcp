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
import { makeLiveSieveIo, makeMailRulesStore } from '../rules/store.ts'
import { makeLiveDeps as makeCreateCalendarDeps, registerCreateCalendar } from '../tools/create-calendar.ts'
import {
  makeLiveDeps as makeCreateCalendarEventDeps,
  registerCreateCalendarEvent,
} from '../tools/create-calendar-event.ts'
import { registerCreateMailRule } from '../tools/create-mail-rule.ts'
import {
  makeLiveDeps as makeDeleteCalendarEventDeps,
  registerDeleteCalendarEvent,
} from '../tools/delete-calendar-event.ts'
import { registerDeleteMailRule } from '../tools/delete-mail-rule.ts'
import { makeLiveDeps as makeDownloadAttachmentDeps, registerDownloadAttachment } from '../tools/download-attachment.ts'
import { makeLiveDeps as makeGetEmailDeps, registerGetEmail } from '../tools/get-email.ts'
import { makeLiveDeps as makeGetThreadDeps, registerGetThread } from '../tools/get-thread.ts'
import {
  makeLiveDeps as makeListCalendarEventsDeps,
  registerListCalendarEvents,
} from '../tools/list-calendar-events.ts'
import { makeLiveDeps as makeListCalendarsDeps, registerListCalendars } from '../tools/list-calendars.ts'
import { registerListMailRules } from '../tools/list-mail-rules.ts'
import { makeLiveDeps as makeRespondToEventDeps, registerRespondToEvent } from '../tools/respond-to-event.ts'
import { makeLiveDeps as makeSearchEmailsDeps, registerSearchEmails } from '../tools/search-emails.ts'
import {
  makeLiveDeps as makeUpdateCalendarEventDeps,
  registerUpdateCalendarEvent,
} from '../tools/update-calendar-event.ts'

export interface McpHandlerConfig {
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
  const downloadAttachmentDeps = makeDownloadAttachmentDeps(jmapLive, cfg.tickets, cfg.publicUrl)
  // CalDAV tools discover against the same Stalwart base; tsdav follows
  // /.well-known/caldav to /dav/cal.
  const caldavCfg = { serverUrl: cfg.stalwartUrl }
  // One resolver (one per-token zone cache) shared by create + update, so a
  // create→update in quick succession reuses the cached AccountSettings read
  // instead of paying the JMAP round-trip twice.
  const resolveTimeZone = makeAccountTimeZoneResolver({ serverUrl: cfg.stalwartUrl })
  // Mail rules persist as one managed Sieve script in the user's Stalwart
  // account; the store shares the request-cycle JMAP session cache.
  const mailRulesStore = makeMailRulesStore(makeLiveSieveIo(jmapLive))
  const listCalendarsDeps = makeListCalendarsDeps(caldavCfg)
  const createCalendarDeps = makeCreateCalendarDeps(caldavCfg)
  const listCalendarEventsDeps = makeListCalendarEventsDeps(caldavCfg)
  const createCalendarEventDeps = makeCreateCalendarEventDeps(caldavCfg, resolveTimeZone)
  const updateCalendarEventDeps = makeUpdateCalendarEventDeps(caldavCfg, resolveTimeZone)
  const deleteCalendarEventDeps = makeDeleteCalendarEventDeps(caldavCfg)
  const respondToEventDeps = makeRespondToEventDeps(caldavCfg)

  return async (req, ctx) => {
    const server = new McpServer({
      name: 'langmail-mcp',
      version: '0.1.0',
    })
    registerSearchEmails(server, searchEmailsDeps, () => ctx.token)
    registerGetEmail(server, getEmailDeps, () => ctx.token)
    registerGetThread(server, getThreadDeps, () => ctx.token)
    registerDownloadAttachment(server, downloadAttachmentDeps, () => ctx.token)
    registerCreateMailRule(server, mailRulesStore, () => ctx.token)
    registerListMailRules(server, mailRulesStore, () => ctx.token)
    registerDeleteMailRule(server, mailRulesStore, () => ctx.token)
    registerListCalendars(server, listCalendarsDeps, () => ctx.token)
    registerCreateCalendar(server, createCalendarDeps, () => ctx.token)
    registerListCalendarEvents(server, listCalendarEventsDeps, () => ctx.token)
    registerCreateCalendarEvent(server, createCalendarEventDeps, () => ctx.token)
    registerUpdateCalendarEvent(server, updateCalendarEventDeps, () => ctx.token)
    registerDeleteCalendarEvent(server, deleteCalendarEventDeps, () => ctx.token)
    registerRespondToEvent(server, respondToEventDeps, () => ctx.token)

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
