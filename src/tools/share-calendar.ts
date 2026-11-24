// share_calendar tool — shares one of the user's calendars with a person
// outside Langmail, at busy-only or full detail, and hands back the secret
// link that person subscribes to (served by calendar-feeds/feed.ts).
//
// Given the person's address, it also emails them the link and how to add it,
// from the user's own address, in the same call: "share my calendar with X"
// means X gets something (langmail/platform#1405). The send half is
// send_draft's: the email is staged in Drafts, then submitted through
// `submitDraft`, so the copy lands in Sent and a failed send leaves a draft.
//
// One share per calendar and person: sharing again changes the level, keeps
// the link and sends nothing, which is also what keeps a retried call from
// emailing twice. Only the secret's hash is stored, so the link is in this
// result and, when sent, in the two mailboxes, and nowhere else.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { mintShareSecret, shareLink } from '../calendar-feeds/shares.ts'
import { holdSend, reservationRefusal, type SendGuard, type SendHold } from '../drafts/send-guard.ts'
import { bearerAuthorization, type EmailAddress } from '../jmap/index.ts'
import { logger } from '../logger/index.ts'
import { describeError } from '../observability/errors.ts'
import { OUTWARD_DESTRUCTIVE } from './annotations.ts'
import { calendarLabel, resolveCalendar } from './calendar-lookup.ts'
import {
  type CalendarSharingContext,
  type CalendarSharingDeps,
  calendarPath,
  levelWords,
  SHARING_OFF,
  sameLabel,
  sharesOn,
} from './calendar-share-common.ts'
import { type DraftToolDeps, parseAddress, type ResolvedIdentity, resolveIdentity } from './draft-common.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'
import { sendDraftSubject, submitDraft, wasRefused } from './send-draft.ts'
import { shareEmail } from './share-calendar-email.ts'

const TOOL_NAME = 'share_calendar'
const MAX_NOTE_CHARS = 1000

const shareCalendarShape = {
  calendar: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The calendar to share: its name (matched ignoring case) or its URL, both as list_calendars shows them. ' +
        'Use the URL when two calendars share a name.'
    ),
  level: z
    .enum(['busy', 'full'])
    .describe(
      '"busy": the person sees only when the user is busy, every event titled "Busy". ' +
        '"full": titles, times, locations, notes and guests; private events still show as busy. ' +
        'Ask the user when they have not said which.'
    ),
  with: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      'Who the calendar is shared with, as the user names them: "Sam", "my partner". A label for the ' +
        'share, never an address: for a person named only by address, use their name or the part before @. Sharing the same calendar again with the same label (ignoring case) ' +
        'changes that share’s level.'
    ),
  email: z
    .string()
    .trim()
    .min(3)
    .max(320)
    .optional()
    .describe(
      'The person’s email address, bare or as "Name <address>" (the form search_contacts gives). With it, ' +
        'the link and how to add it are emailed to this address from the user’s own address, immediately. ' +
        'Pass it only when the user typed this address or confirmed it; one found with search_contacts ' +
        '(for "my partner") needs the user’s yes first: ask only whether that address is right, since ' +
        'sharing with someone means they get the link. Leave it out only when the user says they pass the ' +
        'link on themselves, such as by text message.'
    ),
  note: z
    .string()
    .trim()
    .min(1)
    .max(MAX_NOTE_CHARS)
    .optional()
    .describe(
      'Only with `email`: the user’s own words to the person, placed above the link and the steps that ' +
        'Langmail writes, such as a greeting. Leave it out unless the user said what to write.'
    ),
  language: z
    .enum(['de', 'en'])
    .optional()
    .describe(
      'Only with `email`: the language of the email, the one the user writes to this person in; when that is unknown, the one the user is writing to you in. Defaults to "en".'
    ),
}

export const shareCalendarInput = z.object(shareCalendarShape)

export type ShareCalendarArgs = z.infer<typeof shareCalendarInput>

const LEVEL_SHOWS = {
  busy: 'they see when you are busy, with every event titled "Busy" and no details',
  full: 'they see titles, times, locations, notes and guests; private events show only as busy',
} as const

const howToAdd = (person: string): string =>
  [
    `How ${person} adds it:`,
    '- Google Calendar (on a computer): Other calendars → + → From URL, then paste the link.',
    '- Apple Calendar: on a Mac, File → New Calendar Subscription; on an iPhone, Settings → Apps → Calendar → ' +
      'Calendar Accounts → Add Account → Other → Add Subscribed Calendar.',
    '- Outlook: Add calendar → Subscribe from web, then paste the link.',
    '',
    `How often the calendar refreshes is up to ${person}’s app, not Langmail: Google Calendar picks up ` +
      'changes every few hours, sometimes only once a day; Apple Calendar and Outlook refresh every few hours ' +
      'or as the subscriber sets.',
  ].join('\n')

// What sending the email needs on top of the sharing deps: the composition
// deps send_draft uses, and its send guard.
export interface ShareCalendarSendDeps {
  drafts: DraftToolDeps
  guard: SendGuard
}

export interface ShareCalendarContext extends CalendarSharingContext {
  args: ShareCalendarArgs
  // The authenticated mailbox address: the identity the email goes out as.
  principal: string
}

const NOTHING_DONE = 'Nothing was shared, nothing was sent.'

// The link and how to add it, for every answer in which the person has not
// been emailed them.
const linkAndSteps = (person: string, link: string): string[] => [
  `Link for ${person}: ${link}`,
  '',
  'This is the only time Langmail shows this link. Anyone who has it can see the calendar, so pass it on ' +
    `to ${person} only. If it gets lost, stop_sharing_calendar with ${person} and share again for a new link.`,
  '',
  howToAdd(person),
]

// What a share call reserves while it may send: the calendar and the person as
// the caller named them, which a retry repeats. Two calls for the same share
// at once would both find no share yet, so both would create one and email it.
// The calendar as typed, not as resolved: resolving reads, and the
// reservation comes before any read. Two concurrent calls that name one
// calendar differently (its name and its URL) are not caught; a retry repeats
// the same arguments, so it is.
const shareSubject = (args: ShareCalendarArgs) => ({
  key: `${args.calendar.trim().toLowerCase()}\n${args.with.trim().toLowerCase()}`,
  tool: TOOL_NAME,
})

const shareRefusal = (args: ShareCalendarArgs, state: 'in_flight' | 'unknown'): string =>
  state === 'in_flight'
    ? `Sharing "${args.calendar}" with ${args.with} is already in progress. Nothing was shared or sent by ` +
      'this call. Wait, then check list_calendars and the user’s Sent folder.'
    : `An earlier email sharing "${args.calendar}" with ${args.with} failed without saying whether it went ` +
      'out, so nothing was shared or sent again. Check the user’s Sent folder before deciding.'

export const shareCalendar = async (
  deps: CalendarSharingDeps,
  send: ShareCalendarSendDeps,
  ctx: ShareCalendarContext
): Promise<ToolResult> => {
  const { args, principal } = ctx
  if (!deps.shares) {
    return errorResult(`${SHARING_OFF} ${NOTHING_DONE}`)
  }
  if (args.email === undefined) {
    if (args.note !== undefined || args.language !== undefined) {
      return errorResult(
        `\`note\` and \`language\` are for the email, so they need \`email\`, the person’s address. ${NOTHING_DONE}`
      )
    }
    return shareHeld(deps, send, ctx)
  }
  const to = parseAddress(args.email)
  if (!to) {
    return errorResult(
      `Not a valid email address: ${args.email}. Pass a bare address (person@example.com) or the ` +
        `"Name <person@example.com>" form. ${NOTHING_DONE}`
    )
  }
  // Before the first read, like every send: see drafts/send-guard.ts.
  const taken = holdSend(send.guard, principal, shareSubject(args))
  if ('refused' in taken) {
    return errorResult(shareRefusal(args, taken.refused.state))
  }
  try {
    return await shareHeld(deps, send, ctx, { hold: taken.hold, to })
  } finally {
    taken.hold.end()
  }
}

interface Mailing {
  hold: SendHold
  to: EmailAddress
}

// Everything the email needs, read before the share is created, so a wrong
// address, identity or a missing Drafts folder leaves nothing behind.
interface SendSetup {
  accountId: string
  authorization: string
  draftsMailboxId: string
  identity: ResolvedIdentity
  sentMailboxId?: string
  submissionAccountId: string
}

const prepareSend = async (
  drafts: DraftToolDeps,
  token: string,
  principal: string
): Promise<{ error: string } | SendSetup> => {
  const authorization = bearerAuthorization(token)
  const accountId = await drafts.resolveAccountId(authorization)
  const submissionAccountId = await drafts.resolveSubmissionAccountId(authorization)
  const identity = await resolveIdentity(drafts, { accountId: submissionAccountId, authorization, principal })
  if ('error' in identity) {
    return { error: `${identity.error} ${NOTHING_DONE}` }
  }
  const mailboxes = await drafts.resolveComposeMailboxes(authorization)
  if (!mailboxes.drafts) {
    return { error: `This account has no Drafts folder, so the email cannot be composed. ${NOTHING_DONE}` }
  }
  return {
    accountId,
    authorization,
    draftsMailboxId: mailboxes.drafts,
    identity,
    ...(mailboxes.sent ? { sentMailboxId: mailboxes.sent } : {}),
    submissionAccountId,
  }
}

const shareHeld = async (
  deps: CalendarSharingDeps,
  send: ShareCalendarSendDeps,
  ctx: ShareCalendarContext,
  mailing?: Mailing
): Promise<ToolResult> => {
  const { args, principal, token, userId } = ctx
  const shares = deps.shares
  if (!shares) {
    return errorResult(`${SHARING_OFF} ${NOTHING_DONE}`)
  }
  const calendars = await deps.listCalendars(token)
  const resolved = resolveCalendar(calendars, args.calendar, {
    argName: 'calendar',
    nothingDone: mailing ? NOTHING_DONE : 'Nothing was shared.',
  })
  if (!resolved.ok) {
    return resolved.error
  }
  const calendar = resolved.calendar
  const name = calendarLabel(calendar)
  const person = args.with

  // An existing share never sends: its link is not stored, and this is also
  // what makes a repeated call send no second email.
  const existing = sharesOn(await shares.list(userId), calendar).find((s) => sameLabel(s.label, person))
  if (existing) {
    const keep =
      `${existing.label}’s existing link keeps working, so there is nothing new to pass on${
        mailing ? ', and nothing was emailed' : ''
      }. Langmail cannot show or send that link again; if it is lost, stop_sharing_calendar and share again ` +
      'for a new one.'
    if (existing.level === args.level) {
      return textResult(
        `"${name}" is already shared with ${existing.label} at ${levelWords(args.level)}. Nothing changed. ${keep}`
      )
    }
    await shares.setLevel(userId, existing.id, args.level)
    return textResult(
      `"${name}" is now shared with ${existing.label} at ${levelWords(args.level)} (was ${levelWords(existing.level)}): ` +
        `${LEVEL_SHOWS[args.level]}. ${keep} The change shows the next time their app refreshes.`
    )
  }

  let setup: SendSetup | undefined
  if (mailing) {
    const prepared = await prepareSend(send.drafts, token, principal)
    if ('error' in prepared) {
      return errorResult(prepared.error)
    }
    setup = prepared
  }

  const { secret, secretHash } = mintShareSecret()
  await shares.create(userId, {
    calendarUrl: calendarPath(calendar.url),
    label: person,
    level: args.level,
    secretHash,
  })
  const link = shareLink(deps.publicUrl, secret)
  const shared = `Shared "${name}" with ${person} at ${levelWords(args.level)}: ${LEVEL_SHOWS[args.level]}.`
  if (!(mailing && setup)) {
    return textResult([shared, '', ...linkAndSteps(person, link)].join('\n'))
  }
  return emailLink(send.drafts, { args, calendar: name, link, mailing, setup, shared })
}

interface EmailLinkParams {
  args: ShareCalendarArgs
  calendar: string
  link: string
  mailing: Mailing
  setup: SendSetup
  shared: string
}

// Stage the email in Drafts and submit it the way send_draft does. The share
// exists by now and stays whatever happens here: the link works, and a
// rollback could fail too. Every answer that is not a clean send starts with
// that and gives the link and the steps.
const emailLink = async (drafts: DraftToolDeps, p: EmailLinkParams): Promise<ToolResult> => {
  const { args, mailing, setup } = p
  const person = args.with
  const address = mailing.to.email
  const notSent = (first: string): ToolResult =>
    textResult([first, '', p.shared, '', ...linkAndSteps(person, p.link)].join('\n'))
  const sender = setup.identity.address.name || setup.identity.address.email
  const email = shareEmail({
    calendar: p.calendar,
    language: args.language ?? 'en',
    level: args.level,
    link: p.link,
    ...(args.note ? { note: args.note } : {}),
    sender,
  })
  const draft = { from: [setup.identity.address], subject: email.subject, text: email.text, to: [mailing.to] }

  let staged: Awaited<ReturnType<DraftToolDeps['draftCreate']>>
  try {
    staged = await drafts.draftCreate({
      accountId: setup.accountId,
      apiUrl: '',
      authorization: setup.authorization,
      draft,
      mailboxId: setup.draftsMailboxId,
    })
  } catch (error) {
    logger.error({ ...describeError(error), tool: TOOL_NAME }, 'share email could not be staged')
    const detail = error instanceof Error ? error.message : 'unknown error'
    return notSent(
      `The calendar was shared, but the email to ${address} was not sent: it could not be composed (${detail}). If list_drafts shows a draft to ${address} anyway, delete it. ` +
        `Pass the link and the steps below on to ${person}.`
    )
  }
  const clash = mailing.hold.cover(sendDraftSubject(staged.id))
  if (clash) {
    return notSent(
      `The calendar was shared, but the email to ${address} was not sent: ${reservationRefusal(
        sendDraftSubject(staged.id),
        clash
      )} The email is staged as draft ${staged.id}: ask the user before sending it with send_draft.`
    )
  }
  let outcome: string
  try {
    outcome = await submitDraft(drafts, {
      authorization: setup.authorization,
      draftId: staged.id,
      draftsMailboxId: setup.draftsMailboxId,
      hold: mailing.hold,
      identityId: setup.identity.identityId,
      submissionAccountId: setup.submissionAccountId,
      ...(setup.sentMailboxId ? { sentMailboxId: setup.sentMailboxId } : {}),
    })
  } catch (error) {
    logger.error({ ...describeError(error), tool: TOOL_NAME }, 'share email submission failed after the share was made')
    const detail = error instanceof Error ? error.message : 'unknown error'
    return notSent(
      wasRefused(error)
        ? `The calendar was shared, but the server refused to send the email to ${address} (${detail}). It is ` +
            `staged as draft ${staged.id}: send it with send_draft once the cause is resolved, or pass the link ` +
            'and the steps below on another way and delete the draft.'
        : `The calendar was shared and the email to ${address} was handed to the server, but the answer was ` +
            `lost (${detail}), so it may already have gone out. Do NOT send it again: check the user’s Sent ` +
            'folder first.'
    )
  }
  return textResult(
    [
      `${p.shared} Emailed the link and how to add it to ${address} from ${setup.identity.address.email}.`,
      `messageId: ${staged.id}`,
      outcome,
      '',
      `Link for ${person}, also in the email: ${p.link}`,
      'This is the only time Langmail shows this link; the copy in the user’s Sent folder is the other place ' +
        `to find it. If it gets lost, stop_sharing_calendar with ${person} and share again for a new link.`,
    ].join('\n')
  )
}

// --- MCP registration ----------------------------------------------------

export const registerShareCalendar = (
  server: McpServer,
  deps: CalendarSharingDeps,
  send: ShareCalendarSendDeps,
  // Bearer, user id and mailbox address threaded per request — see mcp/handler.ts.
  getToken: () => string,
  getUserId: () => string,
  getPrincipal: () => string
): void => {
  server.registerTool(
    TOOL_NAME,
    {
      annotations: OUTWARD_DESTRUCTIVE,
      description:
        'Shares one of the user’s calendars with a person, at busy times only or full details, through a ' +
        'secret link that person adds in Google Calendar, Apple Calendar or Outlook; the calendar stays live ' +
        'behind it. Use this when the user wants someone to see their calendar or their availability. With ' +
        '`email`, it also emails the person the link and how to add it, from the user’s own address, at once: ' +
        'that cannot be undone, so pass an address only when the user typed it or confirmed it (confirm one ' +
        'you found with search_contacts first). Without `email`, nothing is sent and the result has the link ' +
        'and the steps for the user to pass on: relay all of it, with the note that the person’s app decides ' +
        'how often it refreshes. The link is shown only in this result (and in the email, when sent). Sharing ' +
        'the same calendar again with the same `with` label changes the level, keeps their link and sends nothing. ' +
        'To see who can see which calendar use list_calendars; to stop a share use stop_sharing_calendar.',
      inputSchema: z.object(shareCalendarShape),
      title: 'Share calendar',
    },
    (args) =>
      shareCalendar(deps, send, {
        args: shareCalendarInput.parse(args),
        principal: getPrincipal(),
        token: getToken(),
        userId: getUserId(),
      })
  )
}
