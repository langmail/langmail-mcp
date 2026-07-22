// Persistence for mail rules: one managed Sieve script in the user's own
// Stalwart account (RFC 9661 SieveScript objects; content travels as a
// blob). No side database — deleting the script deletes every rule, and a
// ManageSieve client sees exactly what the MCP wrote.
//
// The JMAP wire calls live behind the `SieveIo` seam so the store logic is
// unit-testable; `makeLiveSieveIo` wires the real @langmail/jmap calls.

import {
  accountIdForSieve,
  bearerAuthorization,
  blobDownload,
  blobUpload,
  type JmapLive,
  sieveScriptCreate,
  sieveScriptList,
  sieveScriptUpdate,
} from '@langmail/jmap'

import { generateSieveScript, type MailRule, parseSieveScript, RULES_SCRIPT_NAME } from './rule.ts'

export interface SieveIo {
  createScript: (token: string, blobId: string) => Promise<void>
  downloadScript: (token: string, blobId: string) => Promise<string>
  // The managed script's handle, or null before the first rule is created.
  findScript: (token: string) => Promise<{ blobId: string; id: string } | null>
  updateScript: (token: string, scriptId: string, blobId: string) => Promise<void>
  uploadScript: (token: string, content: string) => Promise<string>
}

export interface MailRulesStore {
  load: (token: string) => Promise<MailRule[]>
  save: (token: string, rules: MailRule[]) => Promise<void>
}

export const makeMailRulesStore = (io: SieveIo): MailRulesStore => ({
  load: async (token) => {
    const script = await io.findScript(token)
    if (!script) {
      return []
    }
    return parseSieveScript(await io.downloadScript(token, script.blobId))
  },
  save: async (token, rules) => {
    const blobId = await io.uploadScript(token, generateSieveScript(rules))
    const script = await io.findScript(token)
    if (script) {
      await io.updateScript(token, script.id, blobId)
    } else {
      await io.createScript(token, blobId)
    }
  },
})

// --- live wiring -------------------------------------------------------------

export const makeLiveSieveIo = (live: JmapLive): SieveIo => {
  const sessionAndAccount = async (token: string) => {
    const session = await live.getSession(bearerAuthorization(token))
    return { accountId: accountIdForSieve(session), session }
  }
  return {
    createScript: async (token, blobId) => {
      const { session, accountId } = await sessionAndAccount(token)
      await sieveScriptCreate({
        accountId,
        apiUrl: session.apiUrl,
        authorization: bearerAuthorization(token),
        blobId,
        name: RULES_SCRIPT_NAME,
      })
    },
    downloadScript: async (token, blobId) => {
      const { session, accountId } = await sessionAndAccount(token)
      const res = await blobDownload({
        accountId,
        authorization: bearerAuthorization(token),
        blobId,
        downloadUrl: session.downloadUrl,
        name: `${RULES_SCRIPT_NAME}.sieve`,
        type: 'application/sieve',
      })
      return res.text()
    },
    findScript: async (token) => {
      const { session, accountId } = await sessionAndAccount(token)
      const scripts = await sieveScriptList({
        accountId,
        apiUrl: session.apiUrl,
        authorization: bearerAuthorization(token),
      })
      const managed = scripts.find((s) => s.name === RULES_SCRIPT_NAME)
      return managed ? { blobId: managed.blobId, id: managed.id } : null
    },
    updateScript: async (token, scriptId, blobId) => {
      const { session, accountId } = await sessionAndAccount(token)
      await sieveScriptUpdate({
        accountId,
        apiUrl: session.apiUrl,
        authorization: bearerAuthorization(token),
        blobId,
        scriptId,
      })
    },
    uploadScript: async (token, content) => {
      const { session, accountId } = await sessionAndAccount(token)
      return blobUpload({
        accountId,
        authorization: bearerAuthorization(token),
        content,
        type: 'application/sieve',
        uploadUrl: session.uploadUrl,
      })
    },
  }
}
