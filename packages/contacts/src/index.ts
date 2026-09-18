// biome-ignore lint/performance/noBarrelFile: package entry point requires re-exports
export { normalizeAddress } from './address-class.ts'
export {
  type CalendarDate,
  daysUntil,
  formatCalendarDate,
  nextOccurrence,
  parseCalendarDate,
  todayUtc,
} from './birthdays.ts'
export { collectedNoteEntry, nextKey, readCollected } from './card.ts'
export {
  BIRTHDAY_KEY,
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
  formatBirthday,
  formatCardAddress,
  parseBirthday,
  patchCardAddress,
  readBirthday,
  readNote,
  readOrganization,
  readPhones,
  readPostalAddresses,
  sourceOf,
  toCardAddress,
  toCardPhone,
  userNoteEntry,
  userNoteKey,
  withBirthday,
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
  Birthday,
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
