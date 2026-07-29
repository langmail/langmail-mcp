// The thin IO layer over the fold: find-or-create the collected book, look
// up candidate cards, fold, apply. Deps are injected so both writers test
// against fakes; `liveCollectionDeps` binds the real @langmail/jmap
// wrappers. All calls run under the caller's own credential — the poller's
// Basic authorization or the MCP request bearer — so collection writes into
// each user's own address book under the user's own Stalwart identity.

import {
  addressBookCreate,
  addressBookList,
  type ContactCardFilter,
  contactCardCreate,
  contactCardGet,
  contactCardQuery,
  contactCardUpdate,
} from '@langmail/jmap'

import { COLLECTED_BOOK_NAME } from './constants.ts'
import { foldObservations } from './fold.ts'
import { type ExtractedObservations } from './types.ts'

export interface CollectionCtx {
  accountId: string
  apiUrl: string
  authorization: string
}

export interface CollectionDeps {
  addressBookCreate: typeof addressBookCreate
  addressBookList: typeof addressBookList
  contactCardCreate: typeof contactCardCreate
  contactCardGet: typeof contactCardGet
  contactCardQuery: typeof contactCardQuery
  contactCardUpdate: typeof contactCardUpdate
}

export const liveCollectionDeps: CollectionDeps = {
  addressBookCreate,
  addressBookList,
  contactCardCreate,
  contactCardGet,
  contactCardQuery,
  contactCardUpdate,
}

// Page size for the candidate query. The whole candidate set is always
// fetched (paged until exhausted) — truncating it would blind the fold to
// existing cards and re-create people, and a 200-message backfill page can
// legitimately reference more than one page of candidates.
const CANDIDATE_PAGE_SIZE = 100

// Collect one batch of observations into the user's address book. Callers
// wrap this in their own failure policy: a collection write must never
// block mail analysis or fail a scheduling action.
//
// Read-modify-write without a compare-and-swap: the fold builds its patch
// from the cards read above, so two writers racing on the same person (the
// poller's batch and a calendar write-through firing together) can have the
// later write replace the extension entry from a stale snapshot, dropping a
// few counter increments or log entries. Accepted MVP gap, in the same
// class as the backfill's re-run double-count: identity data — addresses,
// names, grades — is unaffected, only the volume signals drift slightly,
// and both writers re-observe continuously. A version-checked update
// (`ifInState`) with retry is the fix if that ever shows up in practice.
export const collectContacts = async (
  deps: CollectionDeps,
  ctx: CollectionCtx,
  extracted: ExtractedObservations
): Promise<void> => {
  if (extracted.observations.length === 0) {
    return
  }
  const books = await deps.addressBookList(ctx)
  const collectedBookId =
    books.find((b) => b.name === COLLECTED_BOOK_NAME)?.id ??
    (await deps.addressBookCreate({ ...ctx, name: COLLECTED_BOOK_NAME }))

  // Candidates across ALL books: cards holding an observed address (so a
  // personal-book contact is updated, never duplicated) plus cards matching
  // an observed display name (the merge gate's candidates).
  const conditions: ContactCardFilter[] = []
  for (const address of new Set(extracted.observations.map((o) => o.address))) {
    conditions.push({ email: address })
  }
  for (const name of new Set(extracted.observations.flatMap((o) => (o.name ? [o.name] : [])))) {
    conditions.push({ name })
  }
  const ids: string[] = []
  for (let position = 0; ; position += CANDIDATE_PAGE_SIZE) {
    const page = await deps.contactCardQuery({
      ...ctx,
      filter: { conditions, operator: 'OR' },
      limit: CANDIDATE_PAGE_SIZE,
      position,
    })
    ids.push(...page)
    if (page.length < CANDIDATE_PAGE_SIZE) {
      break
    }
  }
  const cards = await deps.contactCardGet({ ...ctx, ids })

  const { creates, updates } = foldObservations({ cards, collectedBookId }, extracted.observations, extracted.relays)
  for (const card of creates) {
    await deps.contactCardCreate({ ...ctx, card })
  }
  for (const update of updates) {
    await deps.contactCardUpdate({ ...ctx, cardId: update.cardId, patch: update.patch })
  }
}
