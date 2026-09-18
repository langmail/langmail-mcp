// Prose rendering of a contact card, shared by the read tool and the
// writers: what an agent reads back after a write is spelled exactly like
// what search_contacts showed it, down to the `[a0]`-style handles — which
// is what makes "search, then correct one field" a two-call sequence rather
// than a guessing game.
//
// Separate from contact-common.ts so search_contacts depends on the
// formatting alone, not on the write tools' deps bundle (mirrors
// mail-rule-format.ts next to mail-rule-common.ts).

import {
  formatBirthday,
  readBirthday,
  readNote,
  readOrganization,
  readPhones,
  readPostalAddresses,
  sourceOf,
} from '@langmail/contacts'
import { type ContactCard } from '@langmail/jmap'

// Indented so a multi-line note stays visually attached to its contact
// block, which is how the whole search_contacts output is shaped.
const indentNote = (note: string): string => note.split('\n').join('\n     ')

// `birthday: 1990-03-03` / `birthday: --03-03` — the spelling the write
// tools accept, so the line can be echoed straight back into update_contact.
export const birthdayLine = (card: ContactCard): string | undefined => {
  const birthday = readBirthday(card)
  return birthday ? `   birthday: ${formatBirthday(birthday)}` : undefined
}

// The authored half of a card: birthday, phone numbers, postal addresses,
// note. Only the detailed search format and the write confirmations show
// these — the call that resolves a name before drafting mail has no use for
// a street address. The birthday is the one line the concise format shows
// too, so a caller that already printed it passes `{ birthday: false }`.
export const profileLines = (card: ContactCard, shown: { birthday: boolean } = { birthday: true }): string[] => {
  const lines: string[] = []
  const birthday = shown.birthday ? birthdayLine(card) : undefined
  if (birthday) {
    lines.push(birthday)
  }
  const phones = readPhones(card)
  if (phones.length > 0) {
    lines.push('   phones:', ...phones.map((p) => `   - [${p.key}] ${p.number} (${p.label})`))
  }
  const postal = readPostalAddresses(card)
  if (postal.length > 0) {
    lines.push('   postal_addresses:', ...postal.map((a) => `   - [${a.key}] ${a.display} (${a.label})`))
  }
  const note = readNote(card)
  if (note) {
    lines.push(`   note: ${indentNote(note)}`)
  }
  return lines
}

// The whole card as prose — what create_contact and update_contact echo back
// so the caller never has to re-read to see the result of its own write.
export const renderContact = (card: ContactCard): string => {
  const organization = readOrganization(card)
  const emails = Object.values(card.emails ?? {}).map((e) => e.address)
  return [
    card.name?.full ?? '(unnamed)',
    `   contact_id: ${card.id}`,
    ...(organization ? [`   organization: ${organization}`] : []),
    ...(emails.length > 0 ? ['   emails:', ...emails.map((a) => `   - ${a}`)] : []),
    ...profileLines(card),
    `   source: ${sourceOf(card)}`,
  ].join('\n')
}
