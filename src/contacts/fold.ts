// The collection fold: observations in, card mutations out. Pure — no IO —
// so both writers (email-agent poller, MCP calendar tools) and the backfill
// share one exhaustively tested core, and the thin upsert helper only has
// to apply the returned creates, updates and the destroys each update names
// over JMAP.
//
// Ownership rules enforced here: standard card properties belong to the
// user — collection fills blanks (a missing display name, a missing
// address) but never overwrites a non-empty value; the extension property
// is machine-owned and updated freely. Cards already holding an observed
// address — personal-book contacts included — are updated in place, never
// duplicated into the collected book. When a personal-book card and a
// Collected card both hold an observed address (an import of a person
// collection already knew), the Collected card's history is merged into the
// personal card and the Collected card is destroyed, so one address resolves
// to one person.

import { type ContactCard, type ContactCardDraft, type ContactCardEmail } from '../jmap/index.ts'
import { classifyContext, normalizeAddress } from './address-class.ts'
import { cardAddresses, collectedNoteEntry, collectedUid, nextEmailKey, normalizeName, readCollected } from './card.ts'
import { COLLECTED_NOTE_KEY, COLLECTED_PATCH_PATH, INTERACTION_LOG_SIZE, RELAY_LIST_SIZE } from './constants.ts'
import { mergeCollectedExtensions } from './merge.ts'
import { type CollectedExtension, type Confidence, type Observation, type RelaySighting } from './types.ts'

export interface FoldContext {
  // Every existing card that might be touched: cards holding the observed
  // addresses or matching the observed display names, across all address
  // books (the caller queries; over-fetching is harmless).
  cards: ContactCard[]
  collectedBookId: string
}

export interface FoldUpdate {
  // Collected cards merged into this one. The caller destroys them right
  // after this update succeeded, so a failed update leaves both cards.
  absorbs: string[]
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
  // Collected cards merged into this one in this fold.
  absorbs: string[]
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

// Merges a Collected card into a personal card and marks it for destroy. Its
// addresses join the personal card, as collection does for any blank it
// fills; so does the name if the personal card has none. A card already
// listed in `absorbed` was merged by an earlier fold whose destroy never
// landed: its history is not summed again, but anything added to it since
// (an address) still moves over.
const absorb = (into: Working, from: Working, fromEmails: Record<string, ContactCardEmail>): void => {
  into.absorbs.push(from.id ?? '')
  into.touched = true
  into.ext = mergeCollectedExtensions(into.ext, from.ext, from.id ?? '')
  for (const entry of Object.values(fromEmails)) {
    const address = normalizeAddress(entry.address)
    if (!into.addresses.has(address)) {
      into.emails[nextEmailKey(into.emails)] = entry
      into.addresses.add(address)
      into.changedEmails = true
    }
  }
  if (!into.name && from.name) {
    into.name = from.name
    into.changedName = true
  }
}

// The properties a card collection minted carries: what the fold writes, and
// the metadata the server and RFC 9553 add. Anything else on a Collected
// card (a phone, a birthday, a photo, a nickname) was put there by a person.
const COLLECTION_PROPERTIES = new Set([
  '@type',
  'addressBookIds',
  'created',
  'emails',
  'id',
  'kind',
  'name',
  'notes',
  'prodId',
  'uid',
  'updated',
  'version',
])

// A Collected card collection can merge away: in the Collected book only,
// and carrying nothing a person put there. A detail added through
// update_contact or a CardDAV client would be lost with the card, so such a
// pair stays. An allow-list, because the card comes back from the server
// with every JSContact property it holds, typed or not.
const isDisposable = (card: ContactCard, collectedBookId: string): boolean => {
  const books = Object.keys(card.addressBookIds).filter((id) => card.addressBookIds[id])
  const filled = Object.entries(card).filter(([, value]) => value !== null && value !== undefined)
  return (
    books.length === 1 &&
    books[0] === collectedBookId &&
    filled.every(([key]) => COLLECTION_PROPERTIES.has(key)) &&
    Object.keys(card.notes ?? {}).every((key) => key === COLLECTED_NOTE_KEY)
  )
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

// For each observed address held by both a card outside the Collected book
// (or a Collected card merge_contacts merged others into) and one or more
// disposable Collected cards, absorbs the Collected cards into the first
// such personal card. Returns the cards still in play; each
// personal card lists the ones it absorbed, for the caller to destroy.
const mergeCollectedTwins = (ctx: FoldContext, cards: Working[], observations: Observation[]): Working[] => {
  const byId = new Map(ctx.cards.map((c) => [c.id, c]))
  const inCollected = (w: Working): boolean =>
    (byId.get(w.id ?? '')?.addressBookIds[ctx.collectedBookId] ?? false) === true
  let kept = cards
  for (const address of new Set(observations.map((o) => normalizeAddress(o.address)))) {
    const holders = kept.filter((w) => w.addresses.has(address))
    // A Collected card that merge_contacts folded others into counts as a
    // target too: in the moment before the index catches up with a merge, a
    // sighting of a merged address mints a fresh Collected card, which the
    // next batch then folds back into the card the user chose.
    // Only when exactly one holder is such a card: two of them sharing an
    // address are two choices the user made, not a duplicate to clear.
    const mergeTargets = holders.filter((w) => (w.ext.absorbed?.length ?? 0) > 0)
    const personal = holders.find((w) => !inCollected(w)) ?? (mergeTargets.length === 1 ? mergeTargets[0] : undefined)
    if (!personal) {
      continue
    }
    const disposable = holders.filter((w) => {
      const card = byId.get(w.id ?? '')
      return w !== personal && card !== undefined && isDisposable(card, ctx.collectedBookId)
    })
    // A Collected card that shares an address with yet another card stays:
    // its history for that address belongs to neither card alone, and a
    // merge writes to the personal card only, so nothing has to be split.
    const survivors = kept.filter((w) => w !== personal && !disposable.includes(w))
    const doomed = disposable.filter((w) =>
      [...w.addresses].every((a) => personal.addresses.has(a) || !survivors.some((s) => s.addresses.has(a)))
    )
    kept = kept.filter((w) => !doomed.includes(w))
    for (const collected of doomed) {
      absorb(personal, collected, byId.get(collected.id ?? '')?.emails ?? {})
    }
  }
  return kept
}

export const foldObservations = (
  ctx: FoldContext,
  observations: Observation[],
  relays: RelaySighting[] = []
): FoldResult => {
  const initial: Working[] = ctx.cards.map((card) => ({
    absorbs: [],
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
  // A personal-book card and a Collected card holding the same observed
  // address are one person: the personal card takes the history first, so
  // this batch's observations land on it, and the Collected card goes.
  const existing = mergeCollectedTwins(ctx, initial, observations)
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
      absorbs: [],
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
      absorbs: w.absorbs,
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
