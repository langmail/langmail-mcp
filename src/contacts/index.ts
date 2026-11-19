// biome-ignore lint/performance/noBarrelFile: package entry point requires re-exports
export { normalizeAddress } from './address-class.ts'
export {
  type CalendarDate,
  daysUntil,
  formatCalendarDate,
  nextOccurrence,
  parseCalendarDate,
  todayIn,
} from './birthdays.ts'
export {
  collectedNoteEntry,
  collectedUid,
  nextKey,
  readCollected,
} from './card.ts'
export {
  BIRTHDAY_KEY,
  COLLECTED_BOOK_NAME,
  COLLECTED_NOTE_KEY,
  PERSONAL_BOOK_NAME,
  SHOWN_INTERACTIONS,
  USER_NOTE_KEY,
} from './constants.ts'
export {
  mergeCards,
  withPreferredEmail,
} from './merge.ts'
export {
  observationsFromEmail,
  observationsFromEvent,
} from './observations.ts'
export {
  birthAnniversary,
  formatBirthday,
  hasRole,
  isRolePhrase,
  MAX_ROLES,
  normalizeRole,
  parseBirthday,
  patchCardAddress,
  readBirthday,
  readNote,
  readOrganization,
  readPhones,
  readPostalAddresses,
  readRoles,
  sourceOf,
  toCardAddress,
  toCardPhone,
  userNoteEntry,
  userNoteKey,
  withBirthday,
  withRoles,
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
  Birthday,
  CollectedExtension,
  InteractionTuple,
} from './types.ts'
export {
  collectContacts,
  liveCollectionDeps,
} from './upsert.ts'
