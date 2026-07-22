// Shared plain-text rendering of mail rules and existing-mail summaries,
// used by every mail-rule tool so they never disagree about what a rule
// means.

import { type ExistingMailApplyResult, type ExistingMailEstimate } from '../rules/apply.ts'
import { type MailRule, type MailRuleAction, type MailRuleConditions, tagToKeywordSuffix } from '../rules/rule.ts'

export const describeConditions = (conditions: MailRuleConditions, match: MailRule['match']): string => {
  const parts: string[] = []
  if (conditions.from) {
    parts.push(`sender contains "${conditions.from}"`)
  }
  if (conditions.to) {
    parts.push(`recipient contains "${conditions.to}"`)
  }
  if (conditions.subject) {
    parts.push(`subject contains "${conditions.subject}"`)
  }
  if (conditions.bodyContains) {
    parts.push(`body contains "${conditions.bodyContains}"`)
  }
  if (conditions.hasAttachment) {
    parts.push('has an attachment')
  }
  return parts.join(match === 'any' ? ' OR ' : ' AND ')
}

const describeAction = (action: MailRuleAction): string => {
  switch (action.type) {
    case 'addTag':
      return `add tag "${tagToKeywordSuffix(action.tag) ?? action.tag}"`
    case 'archive':
      return 'archive'
    case 'copy':
      return `copy to "${action.mailbox}"`
    case 'delete':
      return 'move to Trash'
    case 'flag':
      return 'flag'
    case 'forward':
      return `forward a copy to ${action.to}`
    case 'markRead':
      return 'mark as read'
    case 'markUnread':
      return 'mark as unread'
    case 'move':
      return `move to "${action.mailbox}"`
    case 'removeTag':
      return `remove tag "${tagToKeywordSuffix(action.tag) ?? action.tag}"`
    case 'stopProcessing':
      return 'stop processing later rules'
    default:
      return 'unknown action'
  }
}

export const describeActions = (actions: MailRuleAction[]): string => actions.map(describeAction).join(', then ')

export const formatMailRule = (index: number, rule: MailRule): string => {
  const title = rule.name ?? describeConditions(rule.conditions, rule.match)
  const status = rule.enabled ? '' : ' (disabled)'
  const lines = [
    `${index}. [${rule.id}] ${title}${status}`,
    `   when ${rule.match === 'any' ? 'ANY' : 'ALL'} of: ${describeConditions(rule.conditions, rule.match)}`,
    `   then: ${describeActions(rule.actions)}`,
  ]
  if (rule.createdAt) {
    lines.push(
      `   created: ${rule.createdAt}${rule.updatedAt && rule.updatedAt !== rule.createdAt ? `, modified: ${rule.updatedAt}` : ''}`
    )
  }
  return lines.join('\n')
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`

export const formatEstimate = (estimate: ExistingMailEstimate, scope: string): string => {
  const cap = estimate.capped ? '+' : ''
  return `Approximately ${estimate.messages}${cap} existing ${scope === 'inbox' ? 'Inbox ' : ''}message(s) match (${estimate.conversations}${cap} conversation(s)).`
}

export const formatApplyResult = (result: ExistingMailApplyResult): string => {
  const lines = [
    `Applied to existing mail: ${plural(result.matched, 'message')} matched, ${result.modified} modified${result.failed > 0 ? `, ${result.failed} failed` : ''}.`,
  ]
  if (result.skippedActions.length > 0) {
    lines.push(`Not applied to existing mail (future mail only): ${result.skippedActions.join(', ')}.`)
  }
  return lines.join('\n')
}
