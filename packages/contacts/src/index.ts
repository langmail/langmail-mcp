// biome-ignore lint/performance/noBarrelFile: package entry point requires re-exports
export { normalizeAddress } from './address-class.ts'
export { collectedNoteEntry, nextKey, readCollected } from './card.ts'
export {
  COLLECTED_BOOK_NAME,
  COLLECTED_NOTE_KEY,
  PERSONAL_BOOK_NAME,
  SHOWN_INTERACTIONS,
  USER_NOTE_KEY,
} from './constants.ts'
export {
  type EmailObservationOptions,
  type EmailObservationRecord,
  type EventObservationOptions,
  type EventObservationRecord,
  observationsFromEmail,
  observationsFromEvent,
} from './observations.ts'
export {
  formatCardAddress,
  patchCardAddress,
  readNote,
  readOrganization,
  readPhones,
  readPostalAddresses,
  sourceOf,
  toCardAddress,
  toCardPhone,
  userNoteEntry,
  userNoteKey,
} from './profile.ts'
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
  ContactSource,
  Direction,
  ExtractedObservations,
  InteractionTuple,
  Observation,
  PhoneLabel,
  PhoneNumber,
  PostalAddress,
  PostalLabel,
  Relationship,
  RelaySighting,
  StoredPhoneNumber,
  StoredPostalAddress,
} from './types.ts'
export { type CollectionCtx, type CollectionDeps, collectContacts, liveCollectionDeps } from './upsert.ts'
