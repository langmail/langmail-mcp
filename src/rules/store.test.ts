import { describe, expect, test } from 'bun:test'

import { generateSieveScript, type MailRule } from './rule.ts'
import { makeMailRulesStore, type SieveIo } from './store.ts'

const rule: MailRule = {
  actions: { moveTo: 'Archive' },
  conditions: { from: 'notifications@github.com' },
  description: 'Automatically archive all GitHub notifications',
  id: 'rule-1a2b3c4d',
}

// An in-memory SieveIo simulating a single-script Stalwart account. Blob and
// script state cross calls so load/save sequences behave like the real thing.
const fakeIo = (): SieveIo & { calls: string[]; script: { blobId: string; id: string } | null } => {
  const blobs = new Map<string, string>()
  let nextBlob = 0
  const io = {
    calls: [] as string[],
    createScript: (_t: string, blobId: string) => {
      io.calls.push('create')
      io.script = { blobId, id: 'script-1' }
      return Promise.resolve()
    },
    downloadScript: (_t: string, blobId: string) => {
      io.calls.push('download')
      return Promise.resolve(blobs.get(blobId) ?? '')
    },
    findScript: (_t: string) => {
      io.calls.push('find')
      return Promise.resolve(io.script)
    },
    script: null as { blobId: string; id: string } | null,
    updateScript: (_t: string, scriptId: string, blobId: string) => {
      io.calls.push('update')
      io.script = { blobId, id: scriptId }
      return Promise.resolve()
    },
    uploadScript: (_t: string, content: string) => {
      io.calls.push('upload')
      const blobId = `blob-${nextBlob++}`
      blobs.set(blobId, content)
      return Promise.resolve(blobId)
    },
  }
  return io
}

describe('makeMailRulesStore', () => {
  test('load returns [] when no managed script exists yet', async () => {
    const io = fakeIo()
    expect(await makeMailRulesStore(io).load('tok')).toEqual([])
    expect(io.calls).toEqual(['find'])
  })

  test('first save creates and activates the script; later saves update it', async () => {
    const io = fakeIo()
    const store = makeMailRulesStore(io)
    await store.save('tok', [rule])
    expect(io.calls).toContain('create')
    await store.save('tok', [rule, { ...rule, description: 'Second', id: 'rule-eeeeeeee' }])
    expect(io.calls).toContain('update')
    expect(await store.load('tok')).toHaveLength(2)
  })

  test('save → load round-trips the rule list through the generated script', async () => {
    const io = fakeIo()
    const store = makeMailRulesStore(io)
    await store.save('tok', [rule])
    expect(await store.load('tok')).toEqual([rule])
    // The stored blob is the canonical generated script, not some other encoding.
    expect(io.script).not.toBeNull()
    expect(await io.downloadScript('tok', io.script?.blobId ?? '')).toBe(generateSieveScript([rule]))
  })
})
