// Read-time scoring: relationship tiers, person ranking, address choice,
// and relative ages. Everything here derives from the stored counters at
// query time, so tuning a threshold (constants.ts) never requires
// re-collection. Raw totals stay internal — the tool exposes the computed
// label plus concrete recent interactions, never counts the caller would
// have to classify itself.

import { type ContactCard } from '@langmail/jmap'

import { classifyContext, normalizeAddress } from './address-class.ts'
import { readCollected } from './card.ts'
import { ACTIVE_MIN_INTERACTIONS, ACTIVE_RECENT_DAYS } from './constants.ts'
import { type AddressContext, type CollectedExtension, type Confidence, type Relationship } from './types.ts'

const DAY_MS = 86_400_000

const totalInteractions = (ext: CollectedExtension): number =>
  Object.values(ext.addresses).reduce((sum, a) => sum + a.count, 0)

const lastSeenOf = (ext: CollectedExtension): string | undefined => {
  let latest: string | undefined
  for (const a of Object.values(ext.addresses)) {
    if (!latest || new Date(a.lastSeen).getTime() > new Date(latest).getTime()) {
      latest = a.lastSeen
    }
  }
  return latest
}

// `active`: enough interactions and a recent one. `incidental`: at most a
// single sighting (including a personal-book card never observed at all).
// `occasional`: everything in between.
export const relationshipFor = (ext: CollectedExtension, now: Date): Relationship => {
  const total = totalInteractions(ext)
  if (total <= 1) {
    return 'incidental'
  }
  const last = lastSeenOf(ext)
  const recent = last !== undefined && now.getTime() - new Date(last).getTime() <= ACTIVE_RECENT_DAYS * DAY_MS
  return total >= ACTIVE_MIN_INTERACTIONS && recent ? 'active' : 'occasional'
}

const TIER_RANK: Record<Relationship, number> = { active: 2, incidental: 0, occasional: 1 }

// Rank: relationship tier, then last interaction, newest first. Ambiguity
// between same-name people is preserved — the tool never merges or picks.
export const rankCards = (cards: ContactCard[], now: Date): ContactCard[] =>
  [...cards].sort((a, b) => {
    const extA = readCollected(a)
    const extB = readCollected(b)
    const tier = TIER_RANK[relationshipFor(extB, now)] - TIER_RANK[relationshipFor(extA, now)]
    if (tier !== 0) {
      return tier
    }
    const lastA = lastSeenOf(extA)
    const lastB = lastSeenOf(extB)
    return (lastB ? new Date(lastB).getTime() : 0) - (lastA ? new Date(lastA).getTime() : 0)
  })

const CONFIDENCE_RANK: Record<Confidence, number> = { confirmed: 2, strong: 1, weak: 0 }

export interface AddressCandidate {
  address: string
  confidence: Confidence
  context: AddressContext
  lastSeen?: string
  // The card marks this address as the one mail should go to (JSContact
  // `pref`, set by merge_contacts or update_contact).
  preferred?: boolean
}

// Every address on a card with its stored grade. An address the user added
// by hand (no collection entry) counts as confirmed — the user asserting a
// pairing outranks anything we inferred.
export const addressCandidates = (card: ContactCard): AddressCandidate[] => {
  const ext = readCollected(card)
  const prefs = Object.values(card.emails ?? {}).flatMap((e) => (typeof e.pref === 'number' ? [e.pref] : []))
  const topPref = prefs.length > 0 ? Math.min(...prefs) : undefined
  return Object.values(card.emails ?? {}).map((e) => {
    const address = normalizeAddress(e.address)
    const entry = ext.addresses[address]
    let context: AddressContext = classifyContext(address)
    if (e.contexts?.work) {
      context = 'work'
    } else if (e.contexts?.private) {
      context = 'private'
    }
    return {
      address,
      confidence: entry?.confidence ?? 'confirmed',
      context,
      ...(entry ? { lastSeen: entry.lastSeen } : {}),
      ...(topPref !== undefined && e.pref === topPref ? { preferred: true } : {}),
    }
  })
}

// Best address under a context bias: context match first (never filtering
// anyone out — `any` skips the bias), then the address the card marks as
// preferred, then confidence, then recency. The bias goes first because the
// caller asked for it explicitly; the preference outranks the grades, which
// are only inferred.
export const bestAddress = (card: ContactCard, context: AddressContext | 'any'): AddressCandidate | undefined =>
  [...addressCandidates(card)].sort((a, b) => {
    if (context !== 'any' && (a.context === context) !== (b.context === context)) {
      return a.context === context ? -1 : 1
    }
    if (Boolean(a.preferred) !== Boolean(b.preferred)) {
      return a.preferred ? -1 : 1
    }
    const conf = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]
    if (conf !== 0) {
      return conf
    }
    return (b.lastSeen ? new Date(b.lastSeen).getTime() : 0) - (a.lastSeen ? new Date(a.lastSeen).getTime() : 0)
  })[0]

// Relative age as prose, computed tool-side so the caller never does date
// arithmetic. Mirrors the design examples: days up to a month, then weeks,
// then months, then years; future dates (an upcoming event) read naturally.
export const relativeAge = (iso: string, now: Date): string => {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) {
    return 'unknown date'
  }
  const days = Math.round((now.getTime() - then) / DAY_MS)
  if (days < 0) {
    const ahead = -days
    if (ahead === 1) {
      return 'tomorrow'
    }
    if (ahead < 30) {
      return `in ${ahead} days`
    }
    return ahead < 84 ? `in ${Math.round(ahead / 7)} weeks` : `in ${Math.round(ahead / 30)} months`
  }
  if (days === 0) {
    return 'today'
  }
  if (days === 1) {
    return 'yesterday'
  }
  if (days < 30) {
    return `${days} days ago`
  }
  if (days < 84) {
    return `${Math.round(days / 7)} weeks ago`
  }
  if (days < 365) {
    return `${Math.round(days / 30)} months ago`
  }
  const years = Math.round(days / 365)
  return years === 1 ? 'a year ago' : `${years} years ago`
}
