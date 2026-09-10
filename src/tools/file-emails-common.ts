// Shared seam for the three filing tools (archive_emails, move_emails,
// trash_emails). They differ only in how the destination is chosen; the
// JMAP write is always one uniform Email/set over a batch of ids, and the
// per-id outcome is reported the same way. Kept out of the rules engine
// on purpose: a rule *creates* missing places, a model-driven tool must not.

import { z } from 'zod'

import {
  accountIdForMail,
  bearerAuthorization,
  type EmailSetChanges,
  type EmailSetManyResult,
  emailSetMailboxes,
  emailSetMany,
  type JmapLive,
  mailboxIdByNameOrRole,
  mailboxIdsByRoles,
  mailboxNames,
} from '@langmail/jmap'

import { errorResult, type ToolResult, textResult } from './result.ts'

const MAX_FILE_IDS = 50

export const idsShape = {
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_FILE_IDS)
    .describe(
      `Message ids to act on (1–${MAX_FILE_IDS}), as returned by search_emails or get_thread. ` +
        'To act on a whole conversation, pass every id get_thread lists.'
    ),
}

// Duplicates are collapsed so one message never appears twice in the batch
// report; the wire call would tolerate them, the counts would not.
export const idsInput = z.object({ ...idsShape, ids: idsShape.ids.transform((ids) => [...new Set(ids)]) })

// Same shape as search_emails' lookup: on a miss the folder names come back
// so the error can say what does exist.
export interface MailboxLookup {
  available: string[]
  id: string | null
}

export interface PlaceIds {
  archive: string | null
  inbox: string | null
  trash: string | null
}

export interface FileEmailsDeps {
  // Wholesale replacement: the message ends up in exactly this mailbox (move, trash).
  replaceMailboxes: (token: string, ids: string[], mailboxId: string) => Promise<EmailSetManyResult>
  // A user-facing folder name → id, with the same place-name-by-role rule
  // search_emails applies. Never creates.
  resolveMailbox: (token: string, name: string) => Promise<MailboxLookup>
  // Inbox/Archive/Trash by RFC 8621 role from one mailbox listing.
  resolvePlaces: (token: string) => Promise<PlaceIds>
  // Targeted add/drop of named mailboxes (archive: +Archive −Inbox).
  updateEmails: (token: string, ids: string[], changes: EmailSetChanges) => Promise<EmailSetManyResult>
}

// One line for the happy path; a second clause naming each refused id and the
// SetError type when the server skipped some. Nothing updated is an error —
// a caller retrying on a stale id list should see it as such.
export const formatBatchResult = (verb: string, result: EmailSetManyResult, suffix = ''): ToolResult => {
  const head = `${verb} ${result.updated.length} message(s)${suffix}.`
  if (result.notUpdated.length === 0) {
    return textResult(head)
  }
  const failed = result.notUpdated.map((e) => `${e.id} (${e.type})`).join(', ')
  const text = `${head} Not updated (${result.notUpdated.length}): ${failed}.`
  return result.updated.length === 0 ? errorResult(text) : textResult(text)
}

// --- live-deps wiring ----------------------------------------------------

export const makeLiveDeps = (live: JmapLive): FileEmailsDeps => {
  const ctx = async (token: string) => {
    const authorization = bearerAuthorization(token)
    const session = await live.getSession(authorization)
    return { accountId: accountIdForMail(session), apiUrl: session.apiUrl, authorization }
  }
  return {
    replaceMailboxes: async (token, ids, mailboxId) => {
      const c = await ctx(token)
      return emailSetMailboxes({ ...c, ids, mailboxId })
    },
    resolveMailbox: async (token, name) => {
      const c = await ctx(token)
      const id = await mailboxIdByNameOrRole({ ...c, name })
      // The folder listing is only worth a round-trip when the lookup missed.
      return { available: id ? [] : await mailboxNames(c), id }
    },
    resolvePlaces: async (token) => {
      const c = await ctx(token)
      const byRole = await mailboxIdsByRoles({ ...c, roles: ['archive', 'inbox', 'trash'] })
      return { archive: byRole.archive ?? null, inbox: byRole.inbox ?? null, trash: byRole.trash ?? null }
    },
    updateEmails: async (token, ids, changes) => {
      const c = await ctx(token)
      return emailSetMany({ ...c, changes, ids })
    },
  }
}
