import { describe, expect, test } from 'bun:test'

import { COLLECTED_NOTE_KEY, collectedNoteEntry } from '@langmail/contacts'

import { derivedCard, fakeBook } from './contact-test-fixtures.ts'
import { deleteContact, deleteContactInput } from './delete-contact.ts'

const args = deleteContactInput.parse({ contactId: 'card-robin' })

describe('deleteContact', () => {
  test('destroys the card and says the deletion propagates over CardDAV', async () => {
    const book = fakeBook([derivedCard()])
    const result = await deleteContact(book.deps, { args, token: 'tok' })
    expect(result.isError).toBeUndefined()
    expect(book.cards.size).toBe(0)
    expect(result.content[0]?.text).toContain('Robin Fairweather')
    expect(result.content[0]?.text).toContain('CardDAV')
  })

  test('a derived card is a reset, not a suppression — the result says so', async () => {
    const book = fakeBook([derivedCard()])
    const result = await deleteContact(book.deps, { args, token: 'tok' })
    expect(result.content[0]?.text).toContain('will collect them again')
  })

  test('an authored card does not come back, and the result says that instead', async () => {
    const book = fakeBook([
      derivedCard({
        notes: { [COLLECTED_NOTE_KEY]: collectedNoteEntry({ addresses: {}, interactions: [], source: 'authored' }) },
      }),
    ])
    const result = await deleteContact(book.deps, { args, token: 'tok' })
    expect(result.content[0]?.text).toContain('nothing will bring it back')
  })

  test('an unknown id points at search_contacts and destroys nothing', async () => {
    const book = fakeBook([derivedCard()])
    const result = await deleteContact(book.deps, {
      args: deleteContactInput.parse({ contactId: 'card-nope' }),
      token: 'tok',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('search_contacts')
    expect(book.cards.size).toBe(1)
  })
})
