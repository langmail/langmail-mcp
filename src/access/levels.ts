// Access levels: what an agent connected at each level may do through this
// server. The user picks one per agent; every tool sits in the lowest level that
// offers it, and each level offers its own tools plus those of the levels below.
//
//   read-only    reads the account: search, get, preview, download, list.
//   no-send      also changes the account itself: filing, flags, trash, drafts
//                (a staged reply or forward included), uploads, calendars,
//                moving events, contacts, deleting a rule, ending a share.
//                Nothing leaves the account and nobody else is told.
//   everything   also reaches other people: sending, unsubscribing, sharing a
//                calendar, event writes and invitation replies, and the rule
//                writers (a rule may forward mail).
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
  create_contact: 'no-send',
  create_draft: 'no-send',
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
  update_contact: 'no-send',
  update_draft: 'no-send',
  upload_attachments: 'no-send',

  // everything: the event and rule writers come down to no-send in narrowed
  // forms with langmail/platform#1449.
  create_calendar_event: 'everything',
  create_mail_rule: 'everything',
  delete_calendar_event: 'everything',
  forward_message: 'everything',
  reply_to_message: 'everything',
  respond_to_event: 'everything',
  send_draft: 'everything',
  share_calendar: 'everything',
  unsubscribe_from_list: 'everything',
  update_calendar_event: 'everything',
  update_mail_rule: 'everything',
} as const satisfies Record<string, AccessLevel>

export type ToolName = keyof typeof TOOL_ACCESS

export const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOL_ACCESS, name)

// Whether an agent at `level` is offered `tool`.
export const allows = (level: AccessLevel, tool: ToolName): boolean =>
  ACCESS_LEVELS.indexOf(TOOL_ACCESS[tool]) <= ACCESS_LEVELS.indexOf(level)
