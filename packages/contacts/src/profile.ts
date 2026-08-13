// The authored half of a contact: the standard vCard fields a user keeps
// about a person — phone numbers, postal addresses, an organization, a free
// note — mapped between the JSContact card shape and a flat domain shape the
// MCP tools can accept and render.
//
// Deliberately bounded to properties that appear on a standard vCard
// (RFC 9553 §2.3.3 Phone, §2.5.1 Address, §2.2.3 Organization, §2.8.1 Note).
// Notes, phones and organizations are where an email client starts growing a
// CRM by accident; the vCard surface is the line that keeps that from
// happening incrementally.
//
// Postal addresses are structured rather than one free-text block: address
// formats are country-specific, and an agent addressing a letter needs the
// components separately.

import {
  type ContactCard,
  type ContactCardAddress,
  type ContactCardAddressComponent,
  type ContactCardNote,
  type ContactCardPhone,
} from '@langmail/jmap'

import { readCollected } from './card.ts'
import { COLLECTED_NOTE_KEY, USER_NOTE_KEY } from './constants.ts'
import {
  type ContactSource,
  type PhoneLabel,
  type PhoneNumber,
  type PostalAddress,
  type PostalLabel,
  type StoredPhoneNumber,
  type StoredPostalAddress,
} from './types.ts'

// --- postal addresses ------------------------------------------------------

// JSContact has no `home` context — `private` is its spelling.
const POSTAL_CONTEXT: Record<PostalLabel, string | undefined> = {
  home: 'private',
  other: undefined,
  work: 'work',
}

// The RFC 9553 component kinds this flat model maps one-to-one. Everything
// else a CardDAV client may have written — `number`, `apartment`, `building`,
// `floor`, `district`, `postOfficeBox` — belongs to the street line: it is
// read as part of `street` and rewritten as one component when `street` is
// replaced, so a correction can neither lose it nor duplicate it.
const LOCALITY_KIND = 'locality'
const POSTCODE_KIND = 'postcode'
const REGION_KIND = 'region'
const STREET_KIND = 'name'
const COUNTRY_KIND = 'country'
const NON_STREET_KINDS = new Set([LOCALITY_KIND, POSTCODE_KIND, REGION_KIND, COUNTRY_KIND, 'separator'])

const componentValue = (
  components: ContactCardAddressComponent[] | null | undefined,
  kind: string
): string | undefined => components?.find((c) => c.kind === kind && c.value)?.value

const componentList = (address: ContactCardAddress): ContactCardAddressComponent[] => address.components ?? []

// Everything that renders on the street line, in stored order — the house
// number an imported card keeps separate from the street name included.
const streetOf = (address: ContactCardAddress): string | undefined => {
  const line = componentList(address)
    .filter((c) => !NON_STREET_KINDS.has(c.kind) && c.value.trim().length > 0)
    .map((c) => c.value.trim())
    .join(' ')
  return line.length > 0 ? line : undefined
}

const postalLabelOf = (contexts: Record<string, boolean>): PostalLabel => {
  if (contexts.work) {
    return 'work'
  }
  return contexts.private ? 'home' : 'other'
}

// One-line rendering off the card itself, so it stays right for a card whose
// components we do not model one-to-one. Written to `full` on every write so
// CardDAV clients that only render the formatted form show something sensible.
export const formatCardAddress = (address: ContactCardAddress): string => {
  const part = (kind: string): string => componentValue(address.components, kind)?.trim() ?? ''
  const cityLine = [part(POSTCODE_KIND), part(LOCALITY_KIND)].filter((p) => p.length > 0).join(' ')
  const country = (address.countryCode ?? part(COUNTRY_KIND)).trim().toUpperCase()
  return [streetOf(address) ?? '', cityLine, part(REGION_KIND), country].filter((p) => p.length > 0).join(', ')
}

const withFull = (address: ContactCardAddress): ContactCardAddress => {
  const full = formatCardAddress(address)
  return full.length > 0 ? { ...address, full } : address
}

export const toCardAddress = (address: PostalAddress): ContactCardAddress => {
  const components: ContactCardAddressComponent[] = []
  const push = (kind: string, value: string | undefined): void => {
    if (value && value.trim().length > 0) {
      components.push({ kind, value: value.trim() })
    }
  }
  // RFC 9553 component kinds: `name` is the street name, not the person's.
  push(STREET_KIND, address.street)
  push(POSTCODE_KIND, address.postalCode)
  push(LOCALITY_KIND, address.city)
  push(REGION_KIND, address.region)
  const context = POSTAL_CONTEXT[address.label]
  return withFull({
    components,
    ...(context ? { contexts: { [context]: true } } : {}),
    ...(address.country ? { countryCode: address.country.toUpperCase() } : {}),
  })
}

// Merges a correction onto a stored address *in place on the card shape*
// rather than rebuilding it from the flat read: a card written by another
// CardDAV client can carry components this model has no field for, and
// rebuilding would silently delete them from every synced device on a
// postal-code-only edit. Named components are replaced, everything else is
// left exactly where it was.
export const patchCardAddress = (
  original: ContactCardAddress,
  patch: Partial<PostalAddress> & { label?: PostalLabel }
): ContactCardAddress => {
  let components = componentList(original)
  const replace = (kind: string, value: string | undefined): void => {
    if (value === undefined) {
      return
    }
    components = components.filter((c) => c.kind !== kind)
    if (value.trim().length > 0) {
      components.push({ kind, value: value.trim() })
    }
  }
  // Replacing the street replaces the whole street line — the read the caller
  // corrected against was that line joined, so anything less would leave a
  // stale house number stranded in front of the new street.
  if (patch.street !== undefined) {
    components = components.filter((c) => NON_STREET_KINDS.has(c.kind))
    replace(STREET_KIND, patch.street)
  }
  replace(POSTCODE_KIND, patch.postalCode)
  replace(LOCALITY_KIND, patch.city)
  replace(REGION_KIND, patch.region)
  if (patch.country !== undefined) {
    // The card carries the country in one place after this, never two.
    components = components.filter((c) => c.kind !== COUNTRY_KIND)
  }
  // Relabelling rewrites only the two contexts this model owns; a card's
  // `billing` / `delivery` markers are not ours to drop.
  const owned = new Set(Object.values(POSTAL_CONTEXT).filter(Boolean))
  const kept = Object.entries(original.contexts ?? {}).filter(([k]) => patch.label === undefined || !owned.has(k))
  const added = patch.label === undefined ? undefined : POSTAL_CONTEXT[patch.label]
  const contexts = Object.fromEntries(added ? [...kept, [added, true]] : kept)
  return withFull({
    ...original,
    components,
    ...(Object.keys(contexts).length > 0 ? { contexts } : {}),
    ...(patch.country === undefined ? {} : { countryCode: patch.country.toUpperCase() }),
  })
}

// Defensive: cards are editable in any CardDAV client, so every part may be
// missing or shaped differently than we wrote it (a foreign client may carry
// the country as a component rather than `countryCode`).
const fromCardAddress = (key: string, address: ContactCardAddress): StoredPostalAddress => {
  const part = (kind: string): string | undefined => componentValue(address.components, kind)
  const city = part(LOCALITY_KIND)
  const country = address.countryCode ?? part(COUNTRY_KIND)
  const postalCode = part(POSTCODE_KIND)
  const region = part(REGION_KIND)
  const street = streetOf(address)
  return {
    ...(city ? { city } : {}),
    ...(country ? { country: country.toUpperCase() } : {}),
    // What the tools print: the card's own formatted line where it has one,
    // so an address with components we do not model still reads correctly.
    display: address.full?.trim() || formatCardAddress(address),
    key,
    label: postalLabelOf(address.contexts ?? {}),
    ...(postalCode ? { postalCode } : {}),
    ...(region ? { region } : {}),
    ...(street ? { street } : {}),
  }
}

export const readPostalAddresses = (card: ContactCard): StoredPostalAddress[] =>
  Object.entries(card.addresses ?? {}).map(([key, address]) => fromCardAddress(key, address))

// --- phones ----------------------------------------------------------------

export const toCardPhone = (phone: PhoneNumber): ContactCardPhone => {
  const number = phone.number.trim()
  switch (phone.label) {
    case 'fax':
      return { features: { fax: true }, number }
    case 'home':
      return { contexts: { private: true }, features: { voice: true }, number }
    case 'mobile':
      return { features: { mobile: true }, number }
    case 'work':
      return { contexts: { work: true }, features: { voice: true }, number }
    default:
      return { number }
  }
}

// What the number is beats where it is used: a mobile stays `mobile` even on
// a card that also marks it as the work context.
const phoneLabelOf = (phone: ContactCardPhone): PhoneLabel => {
  const features = phone.features ?? {}
  const contexts = phone.contexts ?? {}
  if (features.mobile) {
    return 'mobile'
  }
  if (features.fax) {
    return 'fax'
  }
  if (contexts.work) {
    return 'work'
  }
  return contexts.private ? 'home' : 'other'
}

const fromCardPhone = (key: string, phone: ContactCardPhone): StoredPhoneNumber => ({
  key,
  label: phoneLabelOf(phone),
  number: phone.number,
})

export const readPhones = (card: ContactCard): StoredPhoneNumber[] =>
  Object.entries(card.phones ?? {}).map(([key, phone]) => fromCardPhone(key, phone))

// --- organization, note, source -------------------------------------------

export const readOrganization = (card: ContactCard): string | undefined =>
  Object.values(card.organizations ?? {}).find((o) => o.name)?.name ?? undefined

// Every note entry except the machine-owned collection payload. A CardDAV
// client may have written its own entries under keys we don't control, so
// the read is "everything that isn't ours" rather than one fixed key.
export const readNote = (card: ContactCard): string | undefined => {
  const text = Object.entries(card.notes ?? {})
    .filter(([key]) => key !== COLLECTED_NOTE_KEY)
    .map(([, entry]) => entry.note)
    .filter((n) => typeof n === 'string' && n.trim().length > 0)
    .join('\n\n')
  return text.length > 0 ? text : undefined
}

// Which note entry a write lands in: the card's single existing user note if
// there is exactly one, so editing a note authored in a CardDAV client edits
// it in place instead of leaving two notes side by side.
export const userNoteKey = (card: ContactCard): string => {
  const keys = Object.keys(card.notes ?? {}).filter((key) => key !== COLLECTED_NOTE_KEY)
  return keys.length === 1 ? (keys[0] as string) : USER_NOTE_KEY
}

export const userNoteEntry = (note: string): ContactCardNote => ({ note })

// Absent marker means the card predates Langmail's own writes — it came in
// through an address book we sync rather than from collection or the tools.
export const sourceOf = (card: ContactCard): ContactSource => readCollected(card).source ?? 'imported'
