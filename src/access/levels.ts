// Access levels: what an agent connected at each level may do through this
// server. The user picks one per agent; every tool sits in the lowest level that
// offers it, and each level offers its own tools plus those of the levels below.
//
//   read-only    reads the account: search, get, preview, download, list.
//   no-send      also changes the account itself: filing, flags, trash, drafts
//                (a staged reply or forward included), uploads, calendars,
//                personal events (ones nobody else is on), moving events,
//                contacts, mail rules without a forward action, ending a share.
//                Nothing leaves the account and nobody else is told.
//   everything   also reaches other people: sending, unsubscribing, sharing a
//                calendar, events with attendees, invitation replies, and rules
//                that forward mail.
//
// The event and rule writers sit in no-send but register a narrowed form there
// (`reachesOthers` below): no attendees or `notify` on events, no forward action
// on rules, and a refusal for an event that has attendees or a rule that
// already forwards. Everything registers their full form.
//
// The level limits what the agent does through this server only. The bearer
// token (hosted) or app password (self-hosted) keeps full rights on Stalwart.
//
// A tool registered without an entry here fails at registration
// (restrict.ts), so every test that builds the server fails until it gets one.

export type AccessLevel = 'read-only' | 'no-send' | 'everything'

export const ACCESS_LEVELS: readonly AccessLevel[] = ['read-only', 'no-send', 'everything']

// The names the user sees on the consent screen and under Access.
export const ACCESS_LEVEL_NAMES: Record<AccessLevel, string> = {
  everything: 'Everything',
  'no-send': 'Change, never send',
  'read-only': 'Read only',
}

export const TOOL_ACCESS = {
  // read-only
  download_attachment: 'read-only',
  download_email: 'read-only',
  get_draft: 'read-only',
  get_email: 'read-only',
  get_thread: 'read-only',
  list_calendar_events: 'read-only',
  list_calendars: 'read-only',
  list_drafts: 'read-only',
  list_mail_rules: 'read-only',
  list_upcoming_birthdays: 'read-only',
  preview_email: 'read-only',
  preview_mail_rule: 'read-only',
  search_contacts: 'read-only',
  search_emails: 'read-only',

  // no-send
  archive_emails: 'no-send',
  create_calendar: 'no-send',
  create_calendar_event: 'no-send',
  create_contact: 'no-send',
  create_draft: 'no-send',
  create_mail_rule: 'no-send',
  delete_calendar_event: 'no-send',
  delete_contact: 'no-send',
  delete_draft: 'no-send',
  delete_mail_rule: 'no-send',
  mark_emails: 'no-send',
  merge_contacts: 'no-send',
  move_calendar_events: 'no-send',
  move_emails: 'no-send',
  stop_sharing_calendar: 'no-send',
  trash_emails: 'no-send',
  update_calendar: 'no-send',
  update_calendar_event: 'no-send',
  update_contact: 'no-send',
  update_draft: 'no-send',
  update_mail_rule: 'no-send',
  upload_attachments: 'no-send',

  // everything
  forward_message: 'everything',
  reply_to_message: 'everything',
  respond_to_event: 'everything',
  send_draft: 'everything',
  share_calendar: 'everything',
  unsubscribe_from_list: 'everything',
} as const satisfies Record<string, AccessLevel>

export type ToolName = keyof typeof TOOL_ACCESS

export const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOL_ACCESS, name)

// Whether an agent at `level` is offered `tool`.
export const allows = (level: AccessLevel, tool: ToolName): boolean =>
  ACCESS_LEVELS.indexOf(TOOL_ACCESS[tool]) <= ACCESS_LEVELS.indexOf(level)

// Whether an agent at `level` may reach other people. The event and rule
// writers register their full form when it may, their narrowed form otherwise.
export const reachesOthers = (level: AccessLevel): boolean => level === 'everything'
