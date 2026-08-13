// The collection fold: observations in, card mutations out. Pure — no IO —
// so both writers (email-agent poller, MCP calendar tools) and the backfill
// share one exhaustively tested core, and the thin upsert helper only has
// to apply the returned creates/updates over JMAP.
//
// Ownership rules enforced here: standard card properties belong to the
// user — collection fills blanks (a missing display name, a missing
// address) but never overwrites a non-empty value; the extension property
// is machine-owned and updated freely. Cards already holding an observed
// address — personal-book contacts included — are updated in place, never
// duplicated into the collected book.

import { type ContactCard, type ContactCardDraft, type ContactCardEmail } from '@langmail/jmap'

import { classifyContext, normalizeAddress } from './address-class.ts'
import { cardAddresses, collectedNoteEntry, collectedUid, nextEmailKey, normalizeName, readCollected } from './card.ts'
import { COLLECTED_NOTE_KEY, COLLECTED_PATCH_PATH, INTERACTION_LOG_SIZE, RELAY_LIST_SIZE } from './constants.ts'
import { type CollectedExtension, type Confidence, type Observation, type RelaySighting } from './types.ts'

export interface FoldContext {
  // Every existing card that might be touched: cards holding the observed
  // addresses or matching the observed display names, across all address
  // books (the caller queries; over-fetching is harmless).
  cards: ContactCard[]
  collectedBookId: string
}

export interface FoldUpdate {
  cardId: string
  // Top-level property replacements for ContactCard/set update.
  patch: Record<string, unknown>
}

export interface FoldResult {
  creates: ContactCardDraft[]
  updates: FoldUpdate[]
}

const CONFIDENCE_RANK: Record<Confidence, number> = { confirmed: 2, strong: 1, weak: 0 }

const time = (iso: string): number => new Date(iso).getTime()

// One person being mutated: an existing card (id set) or a new draft.
interface Working {
  addresses: Set<string>
  changedEmails: boolean
  changedName: boolean
  emails: Record<string, ContactCardEmail>
  ext: CollectedExtension
  // Whether the stored card already has a `notes` property: RFC 8620 §5.3
  // rejects a patch path whose parent doesn't exist, so a card without
  // notes gets a full top-level `notes` set instead of the scoped path
  // (safe — there are no user note entries to clobber on such a card).
  hasNotes: boolean
  id?: string
  name?: string
  recordIds: Set<string>
  touched: boolean
}

const addAddress = (w: Working, address: string): void => {
  w.emails[nextEmailKey(w.emails)] = { address, contexts: { [classifyContext(address)]: true } }
  w.addresses.add(address)
  w.changedEmails = true
}

const apply = (w: Working, obs: Observation): void => {
  const address = normalizeAddress(obs.address)
  if (!w.addresses.has(address)) {
    addAddress(w, address)
  }
  const entry = w.ext.addresses[address]
  // The interaction log doubles as a short-range dedup window: re-folding a
  // record already in the log (a retried poll batch) upgrades confidence at
  // most — it never double-counts. Re-runs older than the window still
  // inflate counters; accepted MVP gap, documented in the plan.
  const alreadyLogged = w.ext.interactions.some((t) => t.recordId === obs.recordId)
  if (entry) {
    if (CONFIDENCE_RANK[obs.confidence] > CONFIDENCE_RANK[entry.confidence]) {
      entry.confidence = obs.confidence
      w.touched = true
    }
    if (!alreadyLogged) {
      entry.count += 1
      if (time(obs.date) > time(entry.lastSeen)) {
        entry.lastSeen = obs.date
      }
      if (time(obs.date) < time(entry.firstSeen)) {
        entry.firstSeen = obs.date
      }
    }
  } else {
    w.ext.addresses[address] = {
      confidence: obs.confidence,
      count: alreadyLogged ? 0 : 1,
      firstSeen: obs.date,
      lastSeen: obs.date,
    }
    w.touched = true
  }
  if (!alreadyLogged) {
    w.ext.interactions.push({
      channel: obs.channel,
      date: obs.date,
      direction: obs.direction,
      recordId: obs.recordId,
    })
    w.ext.interactions.sort((a, b) => time(b.date) - time(a.date))
    w.ext.interactions = w.ext.interactions.slice(0, INTERACTION_LOG_SIZE)
    w.touched = true
  }
  if (!w.name && obs.name) {
    w.name = obs.name
    w.changedName = true
    w.touched = true
  }
  w.recordIds.add(obs.recordId)
}

// The conservative merge gate: a new address may join an existing person
// only on an exact normalized display-name match PLUS co-occurrence — the
// same record also sighted an address already belonging to that person.
const canJoin = (w: Working, obs: Observation, recordAddresses: Map<string, Set<string>>): boolean => {
  if (!(obs.name && w.name) || normalizeName(obs.name) !== normalizeName(w.name)) {
    return false
  }
  const cooccurring = recordAddresses.get(obs.recordId)
  if (!cooccurring) {
    return false
  }
  for (const a of w.addresses) {
    if (cooccurring.has(a) && a !== normalizeAddress(obs.address)) {
      return true
    }
  }
  return false
}

export const foldObservations = (
  ctx: FoldContext,
  observations: Observation[],
  relays: RelaySighting[] = []
): FoldResult => {
  const existing: Working[] = ctx.cards.map((card) => ({
    addresses: new Set(cardAddresses(card)),
    changedEmails: false,
    changedName: false,
    emails: { ...(card.emails ?? {}) },
    ext: readCollected(card),
    hasNotes: typeof card.notes === 'object' && card.notes !== null,
    id: card.id,
    ...(card.name?.full ? { name: card.name.full } : {}),
    recordIds: new Set<string>(),
    touched: false,
  }))
  const drafts: Working[] = []
  const all = () => [...existing, ...drafts]

  // Which addresses each record sighted — the co-occurrence half of the
  // merge gate (relay and self addresses are already extracted away).
  const recordAddresses = new Map<string, Set<string>>()
  for (const obs of observations) {
    const set = recordAddresses.get(obs.recordId) ?? new Set()
    set.add(normalizeAddress(obs.address))
    recordAddresses.set(obs.recordId, set)
  }

  // Oldest first, so firstSeen/lastSeen and the log settle deterministically.
  const ordered = [...observations].sort((a, b) => time(a.date) - time(b.date))
  for (const obs of ordered) {
    const address = normalizeAddress(obs.address)
    const holder = all().find((w) => w.addresses.has(address))
    if (holder) {
      apply(holder, obs)
      continue
    }
    const joinable = all().find((w) => canJoin(w, obs, recordAddresses))
    if (joinable) {
      apply(joinable, obs)
      continue
    }
    const draft: Working = {
      addresses: new Set(),
      changedEmails: false,
      changedName: false,
      emails: {},
      // Stamped at creation and round-tripped by readCollected from then on,
      // so a card the collection pipeline minted stays distinguishable from
      // one the user authored through the contact tools.
      ext: { addresses: {}, interactions: [], source: 'derived' },
      // Irrelevant for a draft (creates carry `notes` wholesale), but the
      // shape is shared with existing cards.
      hasNotes: false,
      recordIds: new Set<string>(),
      touched: true,
    }
    drafts.push(draft)
    apply(draft, obs)
  }

  // A relay observed alongside a known person lands in that person's
  // extension data, so the tool can surface it as excluded. A full list
  // keeps its first entries — no write churn once the cap is reached.
  for (const relay of relays) {
    for (const w of all()) {
      if (!w.recordIds.has(relay.recordId)) {
        continue
      }
      const current = w.ext.relays ?? []
      if (!current.includes(relay.address) && current.length < RELAY_LIST_SIZE) {
        w.ext.relays = [...current, relay.address]
        w.touched = true
      }
    }
  }

  const creates: ContactCardDraft[] = drafts.map((d) => {
    const primary = [...d.addresses][0] ?? ''
    return {
      addressBookIds: { [ctx.collectedBookId]: true },
      emails: d.emails,
      notes: { [COLLECTED_NOTE_KEY]: collectedNoteEntry(d.ext) },
      ...(d.name ? { name: { full: d.name } } : {}),
      uid: collectedUid(primary),
      version: '1.0',
    }
  })

  const updates: FoldUpdate[] = existing
    .filter((w) => w.touched)
    .map((w) => ({
      cardId: w.id ?? '',
      // The extension rides a scoped patch path so user-authored note
      // entries on the same card are never replaced — except on a card
      // with no notes at all, where RFC 8620 §5.3 rejects the scoped path
      // (missing parent) and a full top-level set is both required and safe.
      patch: {
        ...(w.hasNotes
          ? { [COLLECTED_PATCH_PATH]: collectedNoteEntry(w.ext) }
          : { notes: { [COLLECTED_NOTE_KEY]: collectedNoteEntry(w.ext) } }),
        ...(w.changedEmails ? { emails: w.emails } : {}),
        ...(w.changedName && w.name ? { name: { full: w.name } } : {}),
      },
    }))

  return { creates, updates }
}
