// In-memory store of short-lived attachment *upload* tickets — the mirror of
// tickets.ts for the other direction.
//
// upload_attachments mints a ticket binding an unguessable token to
// (bearer, accountId, filename, type); PUT /attachments/uploads/:token
// redeems it by streaming the request body into the account's JMAP blob store.
// As with downloads, the token is the credential and the bearer never reaches
// the model. Unlike downloads, a ticket is single-use: `take` removes it, so a
// leaked URL is worth at most one blob, and the TTL is short because the agent
// uploads straight after asking.

import { mintToken } from './tickets.ts'

export const UPLOAD_TICKET_TTL_MINUTES = 15
const UPLOAD_TICKET_TTL_MS = UPLOAD_TICKET_TTL_MINUTES * 60 * 1000

export interface UploadTicket {
  accountId: string
  // Full Authorization header value forwarded to Stalwart on upload.
  authorization: string
  expiresAt: number
  filename: string
  // The media type the blob is stored as, pinned at mint time — the PUT's own
  // Content-Type is ignored.
  type: string
}

export type UploadTicketInput = Omit<UploadTicket, 'expiresAt'>

export interface UploadTicketStore {
  // The ticket, without spending it — null when unknown, used, or expired.
  lookup: (token: string) => UploadTicket | null
  mint: (input: UploadTicketInput) => { expiresAt: number; token: string }
  // The ticket, spent: a second take of the same token returns null.
  take: (token: string) => UploadTicket | null
}

export const createUploadTicketStore = (now: () => number = Date.now): UploadTicketStore => {
  const tickets = new Map<string, UploadTicket>()

  const sweep = (): void => {
    const t = now()
    for (const [token, ticket] of tickets) {
      if (ticket.expiresAt <= t) {
        tickets.delete(token)
      }
    }
  }

  return {
    lookup: (token) => {
      sweep()
      return tickets.get(token) ?? null
    },
    mint: (input) => {
      sweep()
      const token = mintToken()
      const expiresAt = now() + UPLOAD_TICKET_TTL_MS
      tickets.set(token, { ...input, expiresAt })
      return { expiresAt, token }
    },
    take: (token) => {
      sweep()
      const ticket = tickets.get(token) ?? null
      tickets.delete(token)
      return ticket
    },
  }
}
