// biome-ignore lint/performance/noBarrelFile: package entry point requires re-exports
export { collectedNoteEntry, readCollected } from './card.ts'
export { COLLECTED_BOOK_NAME, COLLECTED_NOTE_KEY, SHOWN_INTERACTIONS } from './constants.ts'
export {
  type EmailObservationOptions,
  type EmailObservationRecord,
  type EventObservationOptions,
  type EventObservationRecord,
  observationsFromEmail,
  observationsFromEvent,
} from './observations.ts'
export {
  type AddressCandidate,
  addressCandidates,
  bestAddress,
  rankCards,
  relationshipFor,
  relativeAge,
} from './scoring.ts'
export type {
  AddressContext,
  Channel,
  CollectedAddress,
  CollectedExtension,
  Confidence,
  Direction,
  ExtractedObservations,
  InteractionTuple,
  Observation,
  Relationship,
  RelaySighting,
} from './types.ts'
export { type CollectionCtx, type CollectionDeps, collectContacts, liveCollectionDeps } from './upsert.ts'
