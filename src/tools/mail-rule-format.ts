// Shared plain-text rendering of a mail rule, used by create_mail_rule's
// confirmation and list_mail_rules' listing so the two never disagree about
// what a rule means.

import { type MailRule, tagToKeywordSuffix } from '../rules/rule.ts'

const conditionParts = (rule: MailRule): string[] => {
  const c = rule.conditions
  const parts: string[] = []
  if (c.from) {
    parts.push(`sender contains "${c.from}"`)
  }
  if (c.to) {
    parts.push(`recipient contains "${c.to}"`)
  }
  if (c.subject) {
    parts.push(`subject contains "${c.subject}"`)
  }
  if (c.hasAttachment) {
    parts.push('has an attachment')
  }
  return parts
}

const actionParts = (rule: MailRule): string[] => {
  const a = rule.actions
  const parts: string[] = []
  if (a.markRead) {
    parts.push('mark as read')
  }
  if (a.addTags && a.addTags.length > 0) {
    parts.push(`add tag(s) ${a.addTags.map((t) => `"${tagToKeywordSuffix(t) ?? t}"`).join(', ')}`)
  }
  if (a.moveTo) {
    parts.push(`move to "${a.moveTo}"`)
  }
  if (a.forwardTo) {
    parts.push(`forward a copy to ${a.forwardTo}`)
  }
  return parts
}

export const formatMailRule = (index: number, rule: MailRule): string =>
  [
    `${index}. [${rule.id}] ${rule.description}`,
    `   when: ${conditionParts(rule).join(' AND ')}`,
    `   then: ${actionParts(rule).join('; ')}`,
  ].join('\n')
