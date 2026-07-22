// Applying a rule to EXISTING mail — the explicit, opt-in counterpart to
// the Sieve script that governs future deliveries. Conditions translate to
// a JMAP Email/query filter; actions translate to one uniform Email/set
// patch (keywords + mailbox membership) applied to every match. Two action
// types cannot be replayed onto stored mail and are reported as skipped:
// forward (would re-send old messages) and stopProcessing (only meaningful
// during rule evaluation).
//
// The JMAP wire calls live behind the `ApplyIo` seam so the engine is
// unit-testable; `makeLiveApplyIo` wires the real @langmail/jmap calls.

import {
  accountIdForMail,
  bearerAuthorization,
  type EmailFilter,
  type EmailFilterCondition,
  type EmailSetChanges,
  emailQueryFilter,
  emailSetMany,
  type JmapLive,
  mailboxCreate,
  mailboxIdByName,
  mailboxIdByRole,
  threadsExpandEmailIds,
  toLabelKeyword,
} from '@langmail/jmap'

import { type MailRule, type MailRuleAction, tagToKeywordSuffix } from './rule.ts'

// Backfills touching more matches than this require the client to re-call
// with explicit confirmation (the spec's "large backfills" guard).
export const LARGE_APPLY_THRESHOLD = 200

// Hard per-call ceiling for both estimates and backfills. A full window is
// reported as "N+" and, for apply, the client can simply run the call again
// — the query re-evaluates against the not-yet-modified remainder for
// mailbox-moving rules, and idempotent patches make repeats harmless.
const APPLY_WINDOW = 1000

export type ExistingMailMode = 'messages' | 'conversations'
export type ExistingMailScope = 'all' | 'inbox'

export interface ExistingMailEstimate {
  // True when the count hit the query window — read as "at least".
  capped: boolean
  conversations: number
  messages: number
}

export interface ExistingMailApplyResult {
  failed: number
  matched: number
  modified: number
  // Action types that cannot be applied to existing mail (forward,
  // stopProcessing) — surfaced so the tool result can say so.
  skippedActions: string[]
}

export interface ApplyIo {
  // Distinct-conversation count for the same filter (collapseThreads).
  countConversations: (token: string, filter: EmailFilter, limit: number) => Promise<number>
  expandToThreads: (token: string, emailIds: string[]) => Promise<string[]>
  queryEmailIds: (token: string, filter: EmailFilter, limit: number) => Promise<string[]>
  // Resolve a mailbox by role (archive/trash/inbox) or by name, creating
  // named mailboxes on demand. Returns the mailbox id.
  resolveMailboxByName: (token: string, name: string) => Promise<string>
  resolveMailboxByRole: (token: string, role: 'archive' | 'inbox' | 'trash', createName: string) => Promise<string>
  updateEmails: (
    token: string,
    ids: string[],
    changes: EmailSetChanges
  ) => Promise<{ notUpdated: string[]; updated: string[] }>
}

// --- conditions → JMAP filter ------------------------------------------------

export const ruleFilter = (rule: MailRule, inboxId: string | null): EmailFilter => {
  const conditions: EmailFilterCondition[] = []
  const c = rule.conditions
  if (c.from) {
    conditions.push({ from: c.from })
  }
  if (c.to) {
    conditions.push({ to: c.to })
  }
  if (c.subject) {
    conditions.push({ subject: c.subject })
  }
  if (c.bodyContains) {
    conditions.push({ body: c.bodyContains })
  }
  if (c.hasAttachment) {
    conditions.push({ hasAttachment: true })
  }
  const node: EmailFilter =
    conditions.length === 1 && conditions[0]
      ? conditions[0]
      : { conditions, operator: rule.match === 'any' ? 'OR' : 'AND' }
  // Scope ANDs around the condition node so any/all only governs the
  // user's conditions, never the mailbox restriction.
  return inboxId ? { conditions: [{ inMailbox: inboxId }, node], operator: 'AND' } : node
}

// --- actions → Email/set patch --------------------------------------------------

const APPLYABLE = new Set<MailRuleAction['type']>([
  'addTag',
  'archive',
  'copy',
  'delete',
  'flag',
  'markRead',
  'markUnread',
  'move',
  'removeTag',
])

export const skippedActionTypes = (actions: MailRuleAction[]): string[] => [
  ...new Set(actions.filter((a) => !APPLYABLE.has(a.type)).map((a) => a.type)),
]

interface PatchContext {
  inboxId: string | null
  resolveByName: (name: string) => Promise<string>
  resolveByRole: (role: 'archive' | 'trash', createName: string) => Promise<string>
}

// One uniform EmailSetChanges for the whole batch. Mailbox-moving actions
// (archive/move/delete) add the target and drop the Inbox — the JMAP
// equivalent of Sieve's fileinto cancelling the implicit keep.
export const buildChanges = async (actions: MailRuleAction[], ctx: PatchContext): Promise<EmailSetChanges> => {
  const keywords: Record<string, boolean> = {}
  const mailboxIds: Record<string, boolean> = {}
  let leftInbox = false
  for (const action of actions) {
    switch (action.type) {
      case 'addTag': {
        const suffix = tagToKeywordSuffix(action.tag)
        if (suffix) {
          keywords[toLabelKeyword(suffix)] = true
        }
        break
      }
      case 'archive': {
        mailboxIds[await ctx.resolveByRole('archive', 'Archive')] = true
        leftInbox = true
        break
      }
      case 'copy': {
        mailboxIds[await ctx.resolveByName(action.mailbox)] = true
        break
      }
      case 'delete': {
        mailboxIds[await ctx.resolveByRole('trash', 'Trash')] = true
        leftInbox = true
        break
      }
      case 'flag': {
        keywords.$flagged = true
        break
      }
      case 'markRead': {
        keywords.$seen = true
        break
      }
      case 'markUnread': {
        keywords.$seen = false
        break
      }
      case 'move': {
        mailboxIds[await ctx.resolveByName(action.mailbox)] = true
        leftInbox = true
        break
      }
      case 'removeTag': {
        const suffix = tagToKeywordSuffix(action.tag)
        if (suffix) {
          keywords[toLabelKeyword(suffix)] = false
        }
        break
      }
      default:
        break
    }
  }
  if (leftInbox && ctx.inboxId && !(ctx.inboxId in mailboxIds)) {
    mailboxIds[ctx.inboxId] = false
  }
  return {
    ...(Object.keys(keywords).length > 0 ? { keywords } : {}),
    ...(Object.keys(mailboxIds).length > 0 ? { mailboxIds } : {}),
  }
}

// --- the engine ------------------------------------------------------------------

export interface MailRulesApplier {
  applyToExisting: (
    token: string,
    rule: MailRule,
    mode: ExistingMailMode,
    scope: ExistingMailScope
  ) => Promise<ExistingMailApplyResult>
  estimate: (token: string, rule: MailRule, scope: ExistingMailScope) => Promise<ExistingMailEstimate>
}

export const makeMailRulesApplier = (io: ApplyIo): MailRulesApplier => {
  const scopedFilter = async (token: string, rule: MailRule, scope: ExistingMailScope): Promise<EmailFilter> => {
    const inboxId = scope === 'inbox' ? await io.resolveMailboxByRole(token, 'inbox', 'Inbox') : null
    return ruleFilter(rule, inboxId)
  }
  return {
    applyToExisting: async (token, rule, mode, scope) => {
      const filter = await scopedFilter(token, rule, scope)
      const matchedIds = await io.queryEmailIds(token, filter, APPLY_WINDOW)
      const targetIds = mode === 'conversations' ? await io.expandToThreads(token, matchedIds) : matchedIds
      if (targetIds.length === 0) {
        return { failed: 0, matched: 0, modified: 0, skippedActions: skippedActionTypes(rule.actions) }
      }
      const inboxId = await io.resolveMailboxByRole(token, 'inbox', 'Inbox')
      const changes = await buildChanges(rule.actions, {
        inboxId,
        resolveByName: (name) => io.resolveMailboxByName(token, name),
        resolveByRole: (role, createName) => io.resolveMailboxByRole(token, role, createName),
      })
      if (!(changes.keywords || changes.mailboxIds)) {
        return { failed: 0, matched: targetIds.length, modified: 0, skippedActions: skippedActionTypes(rule.actions) }
      }
      const { updated, notUpdated } = await io.updateEmails(token, targetIds, changes)
      return {
        failed: notUpdated.length,
        matched: targetIds.length,
        modified: updated.length,
        skippedActions: skippedActionTypes(rule.actions),
      }
    },
    estimate: async (token, rule, scope) => {
      const filter = await scopedFilter(token, rule, scope)
      const ids = await io.queryEmailIds(token, filter, APPLY_WINDOW)
      const conversations = await io.countConversations(token, filter, APPLY_WINDOW)
      return { capped: ids.length >= APPLY_WINDOW, conversations, messages: ids.length }
    },
  }
}

// --- live wiring -------------------------------------------------------------------

export const makeLiveApplyIo = (
  live: JmapLive,
  authorize: (token: string) => string = bearerAuthorization
): ApplyIo => {
  const ctx = async (token: string) => {
    const authorization = authorize(token)
    const session = await live.getSession(authorization)
    return { accountId: accountIdForMail(session), apiUrl: session.apiUrl, authorization }
  }
  return {
    countConversations: async (token, filter, limit) => {
      const c = await ctx(token)
      const ids = await emailQueryFilter({ ...c, collapseThreads: true, filter, limit })
      return ids.length
    },
    expandToThreads: async (token, emailIds) => {
      const c = await ctx(token)
      return threadsExpandEmailIds({ ...c, emailIds })
    },
    queryEmailIds: async (token, filter, limit) => {
      const c = await ctx(token)
      return emailQueryFilter({ ...c, filter, limit })
    },
    resolveMailboxByName: async (token, name) => {
      const c = await ctx(token)
      return (await mailboxIdByName({ ...c, name })) ?? mailboxCreate({ ...c, name })
    },
    resolveMailboxByRole: async (token, role, createName) => {
      const c = await ctx(token)
      return (await mailboxIdByRole({ ...c, role })) ?? mailboxCreate({ ...c, name: createName, role })
    },
    updateEmails: async (token, ids, changes) => {
      const c = await ctx(token)
      return emailSetMany({ ...c, changes, ids })
    },
  }
}
