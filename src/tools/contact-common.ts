// Shared seam and input shapes for the three contact write tools. The read
// side (search_contacts) keeps its own richer deps bundle — it hydrates
// subjects and event titles, which no writer needs. Prose rendering, which
// both sides do share, lives in contact-format.ts.

import { z } from 'zod'

import { normalizeAddress } from '@langmail/contacts'
import {
  type AddressBookRecord,
  accountIdForContacts,
  addressBookCreate,
  addressBookList,
  bearerAuthorization,
  type ContactCard,
  type ContactCardCreateParams,
  type ContactCardDestroyParams,
  type ContactCardGetParams,
  type ContactCardQueryParams,
  type ContactCardUpdateParams,
  contactCardCreate,
  contactCardDestroy,
  contactCardGet,
  contactCardQuery,
  contactCardUpdate,
  type JmapLive,
} from '@langmail/jmap'

export interface ContactWriteDeps {
  addressBookCreate: (p: { accountId: string; apiUrl: string; authorization: string; name: string }) => Promise<string>
  addressBookList: (p: { accountId: string; apiUrl: string; authorization: string }) => Promise<AddressBookRecord[]>
  contactCardCreate: (p: ContactCardCreateParams) => Promise<string>
  contactCardDestroy: (p: ContactCardDestroyParams) => Promise<void>
  contactCardGet: (p: ContactCardGetParams) => Promise<ContactCard[]>
  contactCardQuery: (p: ContactCardQueryParams) => Promise<string[]>
  contactCardUpdate: (p: ContactCardUpdateParams) => Promise<void>
  // Contacts-capability account id for the bearer.
  resolveAccountId: (authorization: string) => Promise<string>
}

// The `{ accountId, apiUrl, authorization }` triple every wrapper takes.
// `apiUrl` stays empty here: the live deps fill it from the cached JMAP
// session, exactly as the read side does.
export interface ContactCtx {
  accountId: string
  apiUrl: string
  authorization: string
}

export const contactCtx = async (deps: ContactWriteDeps, token: string): Promise<ContactCtx> => {
  const authorization = bearerAuthorization(token)
  return { accountId: await deps.resolveAccountId(authorization), apiUrl: '', authorization }
}

// Candidate window for the ownership probe. The filter is a whole address, so
// the substring matches are the handful of cards holding an address that
// *contains* it — sized well above that rather than at it, because a window
// that truncated past the real owner would let the guard miss a duplicate
// instead of rejecting it.
const OWNER_WINDOW = 100

// The card that actually holds `address`, or undefined. The RFC 9610 `email`
// filter is a *substring* match, so `ann@example.com` also hits a card
// holding `joann@example.com` — trusting the query alone would refuse a
// legitimate create. The candidates are fetched and compared exactly, the
// same way search_contacts refines its own server-side hits.
export const ownerOfAddress = async (
  deps: ContactWriteDeps,
  ctx: ContactCtx,
  address: string
): Promise<string | undefined> => {
  const wanted = normalizeAddress(address)
  const ids = await deps.contactCardQuery({ ...ctx, filter: { email: wanted }, limit: OWNER_WINDOW })
  const cards = await deps.contactCardGet({ ...ctx, ids })
  return cards.find((c) => Object.values(c.emails ?? {}).some((e) => normalizeAddress(e.address) === wanted))?.id
}

// --- shared input shapes ---------------------------------------------------

// Bare and defaulted variants, the same split the mail-rule fields use: an
// update needs "not provided" to stay observable, a create wants the default.
export const postalLabelSchema = z.enum(['home', 'work', 'other']).describe('What the address is for.')

const postalLabelWithDefault = postalLabelSchema
  .default('other')
  .describe('What the address is for. Defaults to `other`.')

const phoneLabelSchema = z
  .enum(['mobile', 'home', 'work', 'fax', 'other'])
  .default('other')
  .describe('What the number is. Defaults to `other`.')

// Structured, not one free-text block: address formats are country-specific,
// and an agent addressing a letter needs the parts separately.
export const postalAddressSchema = z
  .object({
    city: z.string().min(1).max(100).optional().describe('City or locality, e.g. München.'),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/u)
      .optional()
      .describe('ISO 3166-1 alpha-2 country code, e.g. DE. Convert a country name yourself.'),
    label: postalLabelWithDefault,
    postalCode: z.string().min(1).max(20).optional().describe('Postal or ZIP code, e.g. 80331.'),
    region: z.string().min(1).max(100).optional().describe('State, province, or region — where the country uses one.'),
    street: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Street including the house number, as one line, e.g. "Beispielweg 1".'),
  })
  .refine((a) => Boolean(a.street ?? a.city ?? a.postalCode ?? a.region), {
    message: 'a postal address needs at least a street, city, postal code, or region',
  })

export const phoneSchema = z.object({
  label: phoneLabelSchema,
  number: z.string().min(3).max(50).describe('The number as the user gave it, e.g. "+49 89 1234567".'),
})

export const emailEntrySchema = z.object({
  address: z.email().describe('The email address.'),
  context: z
    .enum(['work', 'private'])
    .optional()
    .describe('Whether this is a work or a private address. Inferred from the domain when omitted.'),
})

// The two vCard spellings (RFC 6350 §4.3.1), validated as a calendar date by
// parseBirthday in the handler — a zod regex alone would accept Feb 30, and
// its error names both spellings, which a bare schema rejection would not.
export const birthdaySchema = z
  .string()
  .max(40)
  .describe('Birthday as `YYYY-MM-DD`, or `--MM-DD` when the year is unknown.')

export const contactIdSchema = z
  .string()
  .min(1)
  .describe('The contact id, as printed by search_contacts under `contact_id`.')

// Reads the card back after a write. A card that vanished between the write
// and the read is not worth failing the tool over — the write succeeded.
export const readBack = async (
  deps: ContactWriteDeps,
  ctx: ContactCtx,
  cardId: string
): Promise<ContactCard | undefined> => {
  const [card] = await deps.contactCardGet({ ...ctx, ids: [cardId] })
  return card
}

// --- live wiring -----------------------------------------------------------

export const makeLiveDeps = (live: JmapLive): ContactWriteDeps => {
  const url = async (authorization: string): Promise<string> => (await live.getSession(authorization)).apiUrl
  return {
    addressBookCreate: async (p) => addressBookCreate({ ...p, apiUrl: await url(p.authorization) }),
    addressBookList: async (p) => addressBookList({ ...p, apiUrl: await url(p.authorization) }),
    contactCardCreate: async (p) => contactCardCreate({ ...p, apiUrl: await url(p.authorization) }),
    contactCardDestroy: async (p) => contactCardDestroy({ ...p, apiUrl: await url(p.authorization) }),
    contactCardGet: async (p) => contactCardGet({ ...p, apiUrl: await url(p.authorization) }),
    contactCardQuery: async (p) => contactCardQuery({ ...p, apiUrl: await url(p.authorization) }),
    contactCardUpdate: async (p) => contactCardUpdate({ ...p, apiUrl: await url(p.authorization) }),
    resolveAccountId: async (authorization) => accountIdForContacts(await live.getSession(authorization)),
  }
}
