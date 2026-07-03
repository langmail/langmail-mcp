// The searchable keyword vocabulary, derived from @langmail/agents so it stays
// in lockstep with the classification taxonomy. Exposed to the model as a
// z.enum on search_emails; mapped to JMAP `$label:` keywords server-side.

import { agentsConfig } from '@langmail/agents'
import { toLabelKeyword } from '@langmail/jmap'

// enum value -> human gloss. Each agent carries its own description; `todo` is
// agent/user bookkeeping the taxonomy doesn't model as an agent, glossed here.
// The AI processed-marker is deliberately absent — it's not a search facet.
const KEYWORD_GLOSSES: Record<string, string> = {
  ...Object.fromEntries(agentsConfig.agents.map((a) => [a.internalLabel, a.description])),
  todo: 'Messages the user (or an agent) flagged as an action item / to-do.',
}

// Ordered enum values: agent internalLabels (config order) then `todo`. The
// non-empty tuple type is what z.enum() requires.
export const KEYWORD_VALUES = Object.keys(KEYWORD_GLOSSES) as [string, ...string[]]

// A single description string glossing every value — zod enums have no
// per-member describe, so we compose one self-documenting blurb that grows
// automatically as the taxonomy grows.
export const KEYWORDS_DESCRIPTION = `Category labels to filter by; multiple values are combined with OR. ${Object.entries(
  KEYWORD_GLOSSES
)
  .map(([value, gloss]) => `"${value}" = ${gloss}`)
  .join('; ')}`

// The `$label:` convention (shared via @langmail/jmap's toLabelKeyword) is
// Bulwark's internal keyword namespace the agent never sees. Enum values
// (already lowercase slugs) are used verbatim as suffixes — including `todo`,
// now that the JMAP-first email-agent writes the canonical `$label:todo`
// (the legacy Gmail-echoed `$label:to-do` was dropped with that migration).
export const keywordToJmapLabel = (value: string): string => toLabelKeyword(value)
