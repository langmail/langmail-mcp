// create_contact tool — writes a person the address book has never seen into
// the user's own address book.
//
// The collected address book is derived: it can only ever hold people who
// have already exchanged mail or shared a calendar event with the user.
// Someone known through another channel — a phone call, a messenger, a
// conversation — has no way in. This is that way in, and the record it writes
// is a full vCard-shaped one (phones, postal addresses, organization, note),
// not just a routing target.
//
// The card is stamped `source: authored` so a later derivation can never
// relabel it, and the collection fold only ever fills blanks on standard
// properties — so nothing typed here is overwritten by what we later infer.

import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import {
  BIRTHDAY_KEY,
  birthAnniversary,
  COLLECTED_BOOK_NAME,
  COLLECTED_NOTE_KEY,
  collectedNoteEntry,
  MAX_ROLES,
  PERSONAL_BOOK_NAME,
  parseBirthday,
  toCardAddress,
  toCardPhone,
  USER_NOTE_KEY,
  userNoteEntry,
  withRoles,
} from '@langmail/contacts'
import {
  type ContactCardAddress,
  type ContactCardDraft,
  type ContactCardEmail,
  type ContactCardPhone,
} from '@langmail/jmap'

import { ACCOUNT_WRITE } from './annotations.ts'
import {
  birthdaySchema,
  type ContactCtx,
  type ContactWriteDeps,
  contactCtx,
  emailEntrySchema,
  ownerOfAddress,
  phoneSchema,
  postalAddressSchema,
  readBack,
  roleSchema,
} from './contact-common.ts'
import { renderContact } from './contact-format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

const createContactShape = {
  birthday: birthdaySchema.optional(),
  emails: z
    .array(emailEntrySchema)
    .max(10)
    .optional()
    .describe('Email addresses for this person. A contact does not need one — a name alone is a valid record.'),
  name: z.string().min(1).max(200).describe('The display name, e.g. "Robin Fairweather".'),
  note: z.string().max(2000).optional().describe('Free-text note about the person.'),
  organization: z.string().min(1).max(200).optional().describe('Company or organization the person belongs to.'),
  phones: z.array(phoneSchema).max(10).optional().describe('Phone numbers for this person.'),
  postalAddresses: z
    .array(postalAddressSchema)
    .max(5)
    .optional()
    .describe('Postal addresses, structured by component.'),
  roles: z
    .array(roleSchema)
    .max(MAX_ROLES)
    .optional()
    .describe(
      'What the person is to the user ("lawyer", "landlord"), so a later "write to my lawyer" finds them. ' +
        'Only roles the user said or confirmed; never inferred from mail.'
    ),
}

export const createContactInput = z.object(createContactShape)

export type CreateContactArgs = z.infer<typeof createContactInput>

// Authored contacts belong in the book the user's own devices sync, not in
// the machine-maintained collected one. `isDefault` names that book when the
// server sets it; when it doesn't, the collected book is excluded explicitly
// rather than trusting `AddressBook/get` order — nothing in RFC 9610 makes
// the first result the user's personal book, and landing an authored contact
// in `Collected` would put it in front of a different set of clients than
// the tool promises. Provisioning one is the last resort, for the degenerate
// case of an account with no address book at all.
const targetBook = async (deps: ContactWriteDeps, ctx: ContactCtx): Promise<string> => {
  const books = await deps.addressBookList(ctx)
  const personal = books.filter((b) => b.name !== COLLECTED_BOOK_NAME)
  return (
    books.find((b) => b.isDefault)?.id ??
    personal[0]?.id ??
    (await deps.addressBookCreate({ ...ctx, name: PERSONAL_BOOK_NAME }))
  )
}

const keyed = <T>(values: T[], prefix: string): Record<string, T> =>
  Object.fromEntries(values.map((value, i) => [`${prefix}${i}`, value]))

export const createContact = async (
  deps: ContactWriteDeps,
  cx: { args: CreateContactArgs; token: string }
): Promise<ToolResult> => {
  const { args } = cx
  const name = args.name.trim()
  if (name.length === 0) {
    return errorResult('name must not be empty.')
  }
  // Parsed before any read, so a malformed date costs no round-trip. `""`
  // is "none", as it is for `note` — the idiom update_contact teaches.
  const birthdayText = args.birthday?.trim()
  const parsedBirthday = birthdayText ? parseBirthday(birthdayText) : undefined
  if (parsedBirthday && 'error' in parsedBirthday) {
    return errorResult(`${parsedBirthday.error} Nothing was created.`)
  }
  const ctx = await contactCtx(deps, cx.token)

  // Pre-write guard: an address already on a card means this person is
  // already known, and a second card would split their history in two.
  for (const { address } of args.emails ?? []) {
    const existing = await ownerOfAddress(deps, ctx, address)
    if (existing) {
      return errorResult(
        `${address} already belongs to an existing contact (contact_id: ${existing}). ` +
          'Use update_contact to add what is missing to that record rather than creating a second one.'
      )
    }
  }

  const emails = keyed<ContactCardEmail>(
    (args.emails ?? []).map((e) => ({
      address: e.address,
      ...(e.context ? { contexts: { [e.context]: true } } : {}),
    })),
    'e'
  )
  const phones = keyed<ContactCardPhone>((args.phones ?? []).map(toCardPhone), 'p')
  const addresses = keyed<ContactCardAddress>((args.postalAddresses ?? []).map(toCardAddress), 'a')
  const note = args.note?.trim()
  const titles = withRoles({}, args.roles ?? [], [])

  const bookId = await targetBook(deps, ctx)
  const card: ContactCardDraft = {
    addressBookIds: { [bookId]: true },
    ...(Object.keys(addresses).length > 0 ? { addresses } : {}),
    // A fresh card has no foreign anniversary entries to preserve, so the
    // reserved key is written directly (withBirthday is for stored cards).
    ...(parsedBirthday ? { anniversaries: { [BIRTHDAY_KEY]: birthAnniversary(parsedBirthday.birthday) } } : {}),
    ...(Object.keys(emails).length > 0 ? { emails } : {}),
    name: { full: name },
    notes: {
      // The machine-owned entry carries the provenance marker; every later
      // fold round-trips it rather than rebuilding it.
      [COLLECTED_NOTE_KEY]: collectedNoteEntry({ addresses: {}, interactions: [], source: 'authored' }),
      ...(note ? { [USER_NOTE_KEY]: userNoteEntry(note) } : {}),
    },
    ...(args.organization ? { organizations: { o0: { name: args.organization.trim() } } } : {}),
    ...(Object.keys(phones).length > 0 ? { phones } : {}),
    ...(Object.keys(titles).length > 0 ? { titles } : {}),
    uid: `urn:langmail:authored:${crypto.randomUUID()}`,
    version: '1.0',
  }

  const cardId = await deps.contactCardCreate({ ...ctx, card })
  const stored = await readBack(deps, ctx, cardId)
  // A card this tool writes carries the `authored` marker, so its source
  // never depends on the Collected book.
  const body = stored ? renderContact(stored, undefined) : `${name}\n   contact_id: ${cardId}`
  return textResult(
    `Created contact:\n\n${body}\n\n` +
      'It is in the account address book, so it syncs to every device connected over CardDAV. ' +
      'Edit single fields with update_contact; the handles in square brackets address one phone or postal address.'
  )
}

// --- MCP registration ----------------------------------------------------

export const registerCreateContact = (server: McpServer, deps: ContactWriteDeps, getToken: () => string): void => {
  server.registerTool(
    'create_contact',
    {
      annotations: ACCOUNT_WRITE,
      description:
        'Create a contact in the user’s address book — a person the address book does not ' +
        'yet know, typically because they have never sent mail or shared a calendar event. ' +
        'Holds a name plus optional email addresses, phone numbers, structured postal ' +
        'addresses, an organization, a birthday, a note, and roles: what the person is to the user ' +
        '("lawyer"), stored only when the user said or confirmed it. Search with search_contacts first: if the ' +
        'person is already known, use update_contact instead so their history stays on one ' +
        'record. The contact syncs to the user’s devices over CardDAV.',
      inputSchema: z.object(createContactShape),
      title: 'Create contact',
    },
    (args) => {
      const parsed = createContactInput.safeParse(args)
      if (!parsed.success) {
        return Promise.resolve(errorResult(parsed.error.issues.map((i) => i.message).join('; ')))
      }
      return createContact(deps, { args: parsed.data, token: getToken() })
    }
  )
}
