// Typed JMAP wrappers for the contacts capability (RFC 9610) — AddressBook
// and ContactCard methods on the same endpoint and Authorization seam as the
// mail surface. Cards are JSContact (RFC 9553) narrowed to the properties
// Langmail reads; vendor extension properties (the collected-contacts
// payload) ride along untyped and are interpreted by @langmail/contacts.

import { type JmapCall, jmapCall, methodResponse } from './request.ts'
import { JmapError } from './session.ts'
import { type AddressBookRecord, type ContactCard, type ContactCardDraft } from './types.ts'

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts']

interface SetError {
  description?: string
  type?: string
}

const setErrorDetail = (err: SetError | undefined): string =>
  [err?.type ?? 'unknown', err?.description].filter(Boolean).join(' — ')

// --- AddressBook/get -------------------------------------------------------

export interface AddressBookListParams extends JmapCall {
  accountId: string
}

// An account holds a handful of books at most (personal + collected), so the
// read side is a single AddressBook/get with `ids: null` (fetch all).
export const addressBookList = async (p: AddressBookListParams): Promise<AddressBookRecord[]> => {
  const resp = await jmapCall(p, {
    methodCalls: [['AddressBook/get', { accountId: p.accountId, ids: null }, '0']],
    using: USING,
  })
  const out = methodResponse<{ list?: AddressBookRecord[] }>(resp, 'AddressBook/get', '0')
  return out.list ?? []
}

// --- AddressBook/set -------------------------------------------------------

export interface AddressBookCreateParams extends JmapCall {
  accountId: string
  name: string
}

// Create an address book and return the server-assigned id. Callers that
// provision lazily should list first — this throws if the server rejects.
export const addressBookCreate = async (p: AddressBookCreateParams): Promise<string> => {
  const resp = await jmapCall(p, {
    methodCalls: [['AddressBook/set', { accountId: p.accountId, create: { b0: { name: p.name } } }, '0']],
    using: USING,
  })
  const out = methodResponse<{ created?: { b0?: { id?: string } }; notCreated?: { b0?: SetError } }>(
    resp,
    'AddressBook/set',
    '0'
  )
  const id = out.created?.b0?.id
  if (!id) {
    throw new JmapError(200, `AddressBook/set did not create ${p.name}: ${setErrorDetail(out.notCreated?.b0)}`)
  }
  return id
}

// --- ContactCard/get -------------------------------------------------------

export interface ContactCardGetParams extends JmapCall {
  accountId: string
  ids: string[]
}

// No `properties` argument: cards are small and the collected extension
// property must come back too, so the full default set is what we want.
export const contactCardGet = async (p: ContactCardGetParams): Promise<ContactCard[]> => {
  if (p.ids.length === 0) {
    return []
  }
  const resp = await jmapCall(p, {
    methodCalls: [['ContactCard/get', { accountId: p.accountId, ids: p.ids }, '0']],
    using: USING,
  })
  const out = methodResponse<{ list?: ContactCard[] }>(resp, 'ContactCard/get', '0')
  return out.list ?? []
}

// --- ContactCard/query -----------------------------------------------------

// RFC 9610 §5.5 filter conditions, narrowed to what search_contacts and the
// collection upsert actually filter on. `email` and `name` match the
// respective properties; `text` matches across all textual properties.
export interface ContactCardFilterCondition {
  email?: string
  inAddressBook?: string
  name?: string
  text?: string
}

export type ContactCardFilter =
  | ContactCardFilterCondition
  | { conditions: ContactCardFilter[]; operator: 'AND' | 'NOT' | 'OR' }

export interface ContactCardQueryParams extends JmapCall {
  accountId: string
  filter?: ContactCardFilter
  limit?: number
  // Zero-based result offset (RFC 8620 §5.5) — the collection upsert pages
  // large candidate sets (backfill batches) through here.
  position?: number
}

export const contactCardQuery = async (p: ContactCardQueryParams): Promise<string[]> => {
  const args: Record<string, unknown> = { accountId: p.accountId, calculateTotal: false }
  if (p.filter !== undefined) {
    args.filter = p.filter
  }
  if (p.limit !== undefined) {
    args.limit = p.limit
  }
  if (p.position !== undefined && p.position > 0) {
    args.position = p.position
  }
  const resp = await jmapCall(p, {
    methodCalls: [['ContactCard/query', args, '0']],
    using: USING,
  })
  const out = methodResponse<{ ids?: string[] }>(resp, 'ContactCard/query', '0')
  return out.ids ?? []
}

// --- ContactCard/set -------------------------------------------------------

export interface ContactCardCreateParams extends JmapCall {
  accountId: string
  card: ContactCardDraft
}

export const contactCardCreate = async (p: ContactCardCreateParams): Promise<string> => {
  const resp = await jmapCall(p, {
    methodCalls: [['ContactCard/set', { accountId: p.accountId, create: { c0: p.card } }, '0']],
    using: USING,
  })
  const out = methodResponse<{ created?: { c0?: { id?: string } }; notCreated?: { c0?: SetError } }>(
    resp,
    'ContactCard/set',
    '0'
  )
  const id = out.created?.c0?.id
  if (!id) {
    throw new JmapError(200, `ContactCard/set did not create card: ${setErrorDetail(out.notCreated?.c0)}`)
  }
  return id
}

export interface ContactCardUpdateParams extends JmapCall {
  accountId: string
  cardId: string
  // RFC 8620 §5.3 PatchObject: JSON-Pointer paths to set (value) or remove
  // (null). Callers must escape `~` and `/` in keys per RFC 6901 — the
  // contacts package only uses generated keys, which never need it.
  patch: Record<string, unknown>
}

export const contactCardUpdate = async (p: ContactCardUpdateParams): Promise<void> => {
  const resp = await jmapCall(p, {
    methodCalls: [['ContactCard/set', { accountId: p.accountId, update: { [p.cardId]: p.patch } }, '0']],
    using: USING,
  })
  const out = methodResponse<{ notUpdated?: Record<string, SetError>; updated?: Record<string, unknown> }>(
    resp,
    'ContactCard/set',
    '0'
  )
  if (!(out.updated && p.cardId in out.updated)) {
    throw new JmapError(
      200,
      `ContactCard/set did not update ${p.cardId}: ${setErrorDetail(out.notUpdated?.[p.cardId])}`
    )
  }
}
