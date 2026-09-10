// In-memory FileEmailsDeps for the filing tools' unit tests. Records every
// targeted patch and every wholesale replacement so a test can assert the
// exact write.

import { type EmailSetChanges, roleForPlaceName } from '@langmail/jmap'

import { type FileEmailsDeps, type PlaceIds } from './file-emails-common.ts'

export interface RecordedPatch {
  changes: EmailSetChanges
  ids: string[]
}

export interface RecordedReplacement {
  ids: string[]
  mailboxId: string
}

export interface FakeFileEmailsDeps extends FileEmailsDeps {
  patches: RecordedPatch[]
  replacements: RecordedReplacement[]
}

const PLACES: PlaceIds = { archive: 'mb-archive', inbox: 'mb-inbox', trash: 'mb-trash' }

// `folders` maps user-facing names (case-insensitive) to ids; `places`
// overrides the role lookup; `missing` ids are reported notFound by Email/set.
// `resolveMailbox` applies the live resolver's rule: a place name ("Bin",
// "inbox") resolves to the mailbox holding that role, anything else by name.
export const fakeDeps = (
  opts: { folders?: Record<string, string>; missing?: string[]; places?: Partial<PlaceIds> } = {}
): FakeFileEmailsDeps => {
  const folders = {
    Archive: 'mb-archive',
    Inbox: 'mb-inbox',
    Projects: 'mb-projects',
    Trash: 'mb-trash',
    ...opts.folders,
  }
  const places = { ...PLACES, ...opts.places }
  const missing = new Set(opts.missing ?? [])
  const patches: RecordedPatch[] = []
  const replacements: RecordedReplacement[] = []
  const outcome = (ids: string[]) => ({
    notUpdated: ids.filter((id) => missing.has(id)).map((id) => ({ id, type: 'notFound' })),
    updated: ids.filter((id) => !missing.has(id)),
  })
  return {
    patches,
    replaceMailboxes: (_token, ids, mailboxId) => {
      replacements.push({ ids, mailboxId })
      return Promise.resolve(outcome(ids))
    },
    replacements,
    resolveMailbox: (_token, name) => {
      const role = roleForPlaceName(name)
      const byRole = role && role in places ? places[role as keyof PlaceIds] : null
      const byName = Object.entries(folders).find(([n]) => n.toLowerCase() === name.trim().toLowerCase())?.[1]
      const id = byRole ?? byName ?? null
      return Promise.resolve({ available: id ? [] : Object.keys(folders), id })
    },
    resolvePlaces: () => Promise.resolve(places),
    updateEmails: (_token, ids, changes) => {
      patches.push({ changes, ids })
      return Promise.resolve(outcome(ids))
    },
  }
}
