import { describe, expect, test } from 'bun:test'

import { agentsConfig } from '@langmail/agents'

import { KEYWORD_VALUES, KEYWORDS_DESCRIPTION, keywordToJmapLabel } from './keywords.ts'

const SLUG_RE = /^[a-z][a-z0-9]*$/u

describe('keyword vocabulary', () => {
  test('enum values are the agent internalLabels plus todo, in config order', () => {
    const expected = [...agentsConfig.agents.map((a) => a.internalLabel), 'todo']
    expect([...KEYWORD_VALUES]).toEqual(expected)
  })

  // Slug-stability guard: the enum values are used verbatim as JMAP keyword
  // suffixes, so every taxonomy label must already be a lowercase slug (no
  // sanitize step needed). If someone adds an internalLabel with uppercase or
  // spaces, this fails loudly.
  test('every agent internalLabel is a stable lowercase slug', () => {
    for (const a of agentsConfig.agents) {
      expect(a.internalLabel).toMatch(SLUG_RE)
    }
  })

  test('maps enum values verbatim to $label: keywords', () => {
    expect(keywordToJmapLabel('receipt')).toBe('$label:receipt')
    expect(keywordToJmapLabel('newsletter')).toBe('$label:newsletter')
    expect(keywordToJmapLabel('direct')).toBe('$label:direct')
    // Canonical since the JMAP-first agent migration — no legacy `to-do` alias.
    expect(keywordToJmapLabel('todo')).toBe('$label:todo')
  })

  test('the enum description glosses every value', () => {
    for (const value of KEYWORD_VALUES) {
      expect(KEYWORDS_DESCRIPTION).toContain(`"${value}"`)
    }
  })
})
