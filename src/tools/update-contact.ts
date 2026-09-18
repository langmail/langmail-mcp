// update_contact tool — edits a stored contact in place.
//
// The edit is a *delta*, never a full replacement, for the same reason
// update_calendar_event takes `removedAttendees` rather than a rebuilt
// attendee list: a replacement object forces a caller to read the whole
// record first and silently drops everything it did not know to re-send.
// Here that would mean an agent correcting a postal code could wipe a phone
// number a CardDAV client added an hour ago.
//
// So: scalars (`name`, `organization`, `note`) are set by naming them and
// cleared with `""`; the repeated fields take `added…` / `removed…` lists;
// and a stored postal address can be corrected component-by-component
// through `updatedPostalAddresses`, addressed by the handle search_contacts
// prints in square brackets.

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  COLLECTED_NOTE_KEY,
  nextKey,
  parseBirthday,
  patchCardAddress,
  readPostalAddresses,
  toCardAddress,
  toCardPhone,
  userNoteEntry,
  userNoteKey,
  withBirthday,
} from '@langmail/contacts'
import { type ContactCard, type ContactCardAddress, type ContactCardEmail, type ContactCardPhone } from '@langmail/jmap'

import { ACCOUNT_WRITE } from './annotations.ts'
import {
  birthdaySchema,
  type ContactWriteDeps,
  contactCtx,
  contactIdSchema,
  emailEntrySchema,
  ownerOfAddress,
  phoneSchema,
  postalAddressSchema,
  postalLabelSchema,
  readBack,
} from './contact-common.ts'
import { renderContact } from './contact-format.ts'
import { errorResult, type ToolResult, textResult } from './result.ts'

// Same components as a new address, all optional: this one merges onto what
// is stored, so a caller fixing a postal code sends the postal code alone.
const postalPatchSchema = z.object({
  city: z.string().min(1).max(100).optional(),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/u)
    .optional(),
  key: z.string().min(1).describe('The handle printed in square brackets by search_contacts, e.g. `a0`.'),
  label: postalLabelSchema.optional(),
  postalCode: z.string().min(1).max(20).optional(),
  region: z.string().min(1).max(100).optional(),
  street: z.string().min(1).max(200).optional(),
})

const updateContactShape = {
  addedEmails: z.array(emailEntrySchema).max(10).optional().describe('Email addresses to add to the contact.'),
  addedPhones: z.array(phoneSchema).max(10).optional().describe('Phone numbers to add to the contact.'),
  addedPostalAddresses: z.array(postalAddressSchema).max(5).optional().describe('Postal addresses to add.'),
  birthday: birthdaySchema
    .optional()
    .describe('New birthday as `YYYY-MM-DD`, or `--MM-DD` when the year is unknown; `""` clears it. Omit to keep it.'),
  contactId: contactIdSchema,
  name: z.string().min(1).max(200).optional().describe('New display name. Omit to keep the stored one.'),
  note: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'New note, replacing every note stored on the contact; `""` clears them. ' +
        'Omit to keep them. (A contact edited elsewhere can carry more than one.)'
    ),
  organization: z
    .string()
    .max(200)
    .optional()
    .describe('New organization; `""` clears it. Omit to keep the stored one.'),
  removedEmails: z.array(z.email()).max(10).optional().describe('Email addresses to remove (case-insensitive).'),
  removedPhones: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe('Phone numbers to remove, each given either as its `[p0]` handle or as the number itself.'),
  removedPostalAddresses: z
    .array(z.string().min(1))
    .max(5)
    .optional()
    .describe('Postal addresses to remove, each given either as its `[a0]` handle or as its label (`home`, `work`).'),
  updatedPostalAddresses: z
    .array(postalPatchSchema)
    .max(5)
    .optional()
    .describe('Corrections to stored postal addresses: name the handle plus only the components that change.'),
}

export const updateContactInput = z
  .object(updateContactShape)
  .refine(
    (a) =>
      a.birthday !== undefined ||
      a.name !== undefined ||
      a.note !== undefined ||
      a.organization !== undefined ||
      Boolean(a.addedEmails ?? a.removedEmails ?? a.addedPhones ?? a.removedPhones) ||
      Boolean(a.addedPostalAddresses ?? a.updatedPostalAddresses ?? a.removedPostalAddresses),
    { message: 'update_contact needs at least one field to change.' }
  )

export type UpdateContactArgs = z.infer<typeof updateContactInput>

// A removal handle matches either the storage key or the value it names, so
// a caller can echo back what it read without knowing which is which.
const matchesHandle = (handles: Set<string>, key: string, ...values: string[]): boolean =>
  handles.has(key) || values.some((v) => handles.has(v.trim().toLowerCase()))

const normalizedHandles = (raw: string[] | undefined): Set<string> =>
  new Set((raw ?? []).map((h) => h.trim().toLowerCase()))

interface Changed {
  addresses?: Record<string, ContactCardAddress>
  emails?: Record<string, ContactCardEmail>
  phones?: Record<string, ContactCardPhone>
}

const resolveEmails = (card: ContactCard, args: UpdateContactArgs): Record<string, ContactCardEmail> | undefined => {
  if (!(args.addedEmails ?? args.removedEmails)) {
    return
  }
  const removed = normalizedHandles(args.removedEmails)
  const kept: Record<string, ContactCardEmail> = Object.fromEntries(
    Object.entries(card.emails ?? {}).filter(([, e]) => !removed.has(e.address.trim().toLowerCase()))
  )
  const present = new Set(Object.values(kept).map((e) => e.address.trim().toLowerCase()))
  for (const entry of args.addedEmails ?? []) {
    if (present.has(entry.address.toLowerCase())) {
      continue
    }
    present.add(entry.address.toLowerCase())
    kept[nextKey(kept, 'e')] = {
      address: entry.address,
      ...(entry.context ? { contexts: { [entry.context]: true } } : {}),
    }
  }
  return kept
}

const resolvePhones = (card: ContactCard, args: UpdateContactArgs): Record<string, ContactCardPhone> | undefined => {
  if (!(args.addedPhones ?? args.removedPhones)) {
    return
  }
  const removed = normalizedHandles(args.removedPhones)
  const kept: Record<string, ContactCardPhone> = Object.fromEntries(
    Object.entries(card.phones ?? {}).filter(([key, p]) => !matchesHandle(removed, key, p.number))
  )
  for (const phone of args.addedPhones ?? []) {
    kept[nextKey(kept, 'p')] = toCardPhone(phone)
  }
  return kept
}

const resolvePostal = (card: ContactCard, args: UpdateContactArgs): Record<string, ContactCardAddress> | undefined => {
  if (!(args.addedPostalAddresses ?? args.updatedPostalAddresses ?? args.removedPostalAddresses)) {
    return
  }
  const stored = new Map(readPostalAddresses(card).map((a) => [a.key, a]))
  const removed = normalizedHandles(args.removedPostalAddresses)
  const kept: Record<string, ContactCardAddress> = Object.fromEntries(
    Object.entries(card.addresses ?? {}).filter(
      ([key]) => !matchesHandle(removed, key, stored.get(key)?.label ?? 'other')
    )
  )
  for (const patch of args.updatedPostalAddresses ?? []) {
    const current = kept[patch.key]
    if (current) {
      // Merged onto the stored card entry, not rebuilt from the flat read:
      // an address written by another CardDAV client can carry components
      // this model has no field for, and rebuilding would delete them.
      kept[patch.key] = patchCardAddress(current, patch)
    }
  }
  for (const address of args.addedPostalAddresses ?? []) {
    kept[nextKey(kept, 'a')] = toCardAddress(address)
  }
  return kept
}

// The note lives in its own entry so the machine-owned collection payload on
// the same card is never touched. Every *other* user note entry is dropped in
// the same patch: `note` is documented as replacing what is stored and `""`
// as clearing it, and search_contacts shows all of them joined — so writing
// beside a note a CardDAV client left behind would report a replacement while
// the old text stayed on screen and on every synced device.
//
// RFC 8620 §5.3 rejects a patch path whose parent is missing, so a card with
// no notes at all takes a full top-level set instead — safe, because there is
// nothing there to clobber.
const notePatch = (card: ContactCard, note: string): Record<string, unknown> => {
  const key = userNoteKey(card)
  const hasNotes = typeof card.notes === 'object' && card.notes !== null
  if (!hasNotes) {
    return note.length === 0 ? {} : { notes: { [key]: userNoteEntry(note) } }
  }
  const superseded = Object.keys(card.notes ?? {}).filter((k) => k !== COLLECTED_NOTE_KEY && k !== key)
  const removals = Object.fromEntries(superseded.map((k) => [`notes/${k}`, null]))
  if (note.length === 0) {
    return key in (card.notes ?? {}) ? { ...removals, [`notes/${key}`]: null } : removals
  }
  return { ...removals, [`notes/${key}`]: userNoteEntry(note) }
}

// The whole `anniversaries` map is re-sent with only the birth entry
// changed: withBirthday keeps every foreign entry (a wedding date a phone
// wrote) in place, and a whole-property set is the one patch shape that is
// valid whether or not the card carried the property before (RFC 8620 §5.3
// rejects a scoped path whose parent is missing). When nothing remains the
// property is set to null — the unambiguous "absent" — rather than to `{}`.
const birthdayPatch = (card: ContactCard, text: string): { error: string } | { patch: Record<string, unknown> } => {
  const parsed = text.length === 0 ? undefined : parseBirthday(text)
  if (parsed && 'error' in parsed) {
    return parsed
  }
  const anniversaries = withBirthday(card, parsed?.birthday)
  return { patch: { anniversaries: Object.keys(anniversaries).length > 0 ? anniversaries : null } }
}

const organizationPatch = (card: ContactCard, organization: string): Record<string, unknown> => {
  if (organization.length === 0) {
    return { organizations: {} }
  }
  const key = Object.keys(card.organizations ?? {})[0] ?? 'o0'
  return { organizations: { [key]: { name: organization } } }
}

// The four scalars — set by naming them, cleared with `""` (name excepted).
const scalarPatch = (
  card: ContactCard,
  args: UpdateContactArgs
): { error: string } | { patch: Record<string, unknown> } => {
  const birthday = args.birthday === undefined ? undefined : birthdayPatch(card, args.birthday.trim())
  if (birthday && 'error' in birthday) {
    return birthday
  }
  return {
    patch: {
      ...(birthday?.patch ?? {}),
      ...(args.name === undefined ? {} : { name: { full: args.name.trim() } }),
      ...(args.note === undefined ? {} : notePatch(card, args.note.trim())),
      ...(args.organization === undefined ? {} : organizationPatch(card, args.organization.trim())),
    },
  }
}

export const updateContact = async (
  deps: ContactWriteDeps,
  cx: { args: UpdateContactArgs; token: string }
): Promise<ToolResult> => {
  const { args } = cx
  const ctx = await contactCtx(deps, cx.token)
  const [card] = await deps.contactCardGet({ ...ctx, ids: [args.contactId] })
  if (!card) {
    return errorResult(
      `No contact with id ${args.contactId}. Use search_contacts to find the person and read their contact_id.`
    )
  }

  // A correction addressed to a handle that isn't on the card is a caller
  // mistake worth failing on: silently doing nothing would read as success.
  const knownKeys = new Set(Object.keys(card.addresses ?? {}))
  const unknown = (args.updatedPostalAddresses ?? []).map((p) => p.key).filter((key) => !knownKeys.has(key))
  if (unknown.length > 0) {
    const available = [...knownKeys].join(', ') || 'none'
    return errorResult(
      `This contact has no postal address ${unknown.join(', ')}. Stored handles: ${available}. ` +
        'Read them back with search_contacts (response_format: "detailed").'
    )
  }

  // Same guard create_contact applies, for the same reason: an address that
  // already belongs to another card would split that person's history, and
  // collection would keep feeding observations to whichever card it matched
  // first while searches returned both.
  for (const { address } of args.addedEmails ?? []) {
    const owner = await ownerOfAddress(deps, ctx, address)
    if (owner && owner !== args.contactId) {
      return errorResult(
        `${address} already belongs to a different contact (contact_id: ${owner}). ` +
          'Remove it there first, or add what is missing to that record instead.'
      )
    }
  }

  const scalars = scalarPatch(card, args)
  if ('error' in scalars) {
    return errorResult(`${scalars.error} Nothing was changed.`)
  }

  const addresses = resolvePostal(card, args)
  const emails = resolveEmails(card, args)
  const phones = resolvePhones(card, args)
  const changed: Changed = {
    ...(addresses === undefined ? {} : { addresses }),
    ...(emails === undefined ? {} : { emails }),
    ...(phones === undefined ? {} : { phones }),
  }
  const patch: Record<string, unknown> = { ...changed, ...scalars.patch }
  if (Object.keys(patch).length === 0) {
    return errorResult('Nothing to change: the requested edit is already the stored state.')
  }

  await deps.contactCardUpdate({ ...ctx, cardId: args.contactId, patch })
  const stored = await readBack(deps, ctx, args.contactId)
  return textResult(
    `Updated contact:\n\n${stored ? renderContact(stored) : args.contactId}\n\n` +
      'Fields you did not name are unchanged. The edit syncs to every device connected over CardDAV.'
  )
}

// --- MCP registration ----------------------------------------------------

export const registerUpdateContact = (server: McpServer, deps: ContactWriteDeps, getToken: () => string): void => {
  server.registerTool(
    'update_contact',
    {
      annotations: ACCOUNT_WRITE,
      description:
        'Edit a stored contact by id, changing only the fields you name — everything else ' +
        'is kept, so you never have to read the record and re-send it. Set `name`, ' +
        '`organization`, `birthday` or `note` directly (`""` clears all but the name); add or remove email ' +
        'addresses, phone numbers and postal addresses with the `added…`/`removed…` lists; ' +
        'correct one component of a stored postal address with `updatedPostalAddresses`. ' +
        'Find the contact_id and the `[a0]`-style handles with search_contacts.',
      inputSchema: updateContactShape,
      title: 'Update contact',
    },
    (args) => {
      const parsed = updateContactInput.safeParse(args)
      if (!parsed.success) {
        return Promise.resolve(errorResult(parsed.error.issues.map((i) => i.message).join('; ')))
      }
      return updateContact(deps, { args: parsed.data, token: getToken() })
    }
  )
}
