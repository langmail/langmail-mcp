// create_calendar tool — issues a CalDAV MKCALENDAR against the authenticated
// principal's calendar-home-set and returns the new calendar's URL so a later
// turn can target it with create_calendar_event.
//
// Like the other CalDAV tools, the logic sits behind a `Deps` interface so it
// unit-tests without live Stalwart; `makeLiveDeps` wires tsdav in.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  type CalDavConfig,
  type CreateCalendarParams,
  createCalendar as createCalendarCollection,
} from '../caldav/client.ts'
import { type ToolResult, textResult } from './result.ts'

// A hex color for the Apple `calendar-color` extension, e.g. "#FF6600" or
// "#FF6600FF" (with alpha). Kept strict so a malformed value can't ride
// straight into the MKCALENDAR body.
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/u, 'color must be a hex value like #FF6600')

export const createCalendarInput = z.object({
  // Optional, but recommended so a new calendar is visually distinct.
  color: colorSchema.optional(),
  name: z.string().min(1).max(200),
})

export type CreateCalendarArgs = z.infer<typeof createCalendarInput>

export interface CreateCalendarDeps {
  createCalendar: (params: CreateCalendarParams) => Promise<string>
}

export interface CreateCalendarContext {
  args: CreateCalendarArgs
  token: string
}

export const createCalendar = async (deps: CreateCalendarDeps, ctx: CreateCalendarContext): Promise<ToolResult> => {
  const { args, token } = ctx
  const url = await deps.createCalendar({
    color: args.color,
    name: args.name,
    token,
  })

  return textResult(
    `Calendar "${args.name}" created.\n` +
      // Surface the URL so a later turn can target it with create_calendar_event.
      `calendarUrl: ${url}`
  )
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (cfg: CalDavConfig): CreateCalendarDeps => ({
  createCalendar: (params) => createCalendarCollection(cfg, params),
})

// --- MCP registration ----------------------------------------------------

export const registerCreateCalendar = (
  server: McpServer,
  deps: CreateCalendarDeps,
  // Bearer threaded per request — see mcp/handler.ts.
  getToken: () => string
): void => {
  server.registerTool(
    'create_calendar',
    {
      description:
        'Creates a new calendar for the authenticated user and returns its CalDAV URL ' +
        '(pass that URL to create_calendar_event to add events to it). Use this when the ' +
        'user wants to keep a workstream’s events separate from their other calendars.',
      inputSchema: createCalendarInput.shape,
      title: 'Create calendar',
    },
    (args) => {
      const parsed = createCalendarInput.parse(args)
      return createCalendar(deps, { args: parsed, token: getToken() })
    }
  )
}
