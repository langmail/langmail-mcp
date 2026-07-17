// In-memory store of short-lived attachment download tickets.
//
// download_attachment mints a ticket binding an unguessable token to
// (bearer, accountId, blobId, name, type); GET /attachments/:token redeems
// it — the token *is* the credential, same model as a presigned URL. The
// bearer therefore never reaches the model or the wire. Single-process
// state is fine: the server is one container, and a restart merely
// invalidates outstanding URLs (the agent re-calls the tool).

export const TICKET_TTL_MINUTES = 15
const TICKET_TTL_MS = TICKET_TTL_MINUTES * 60 * 1000

export interface Ticket {
  accountId: string
  // Full Authorization header value forwarded to Stalwart on redeem.
  authorization: string
  blobId: string
  expiresAt: number
  name: string
  type: string
}

export type TicketInput = Omit<Ticket, 'expiresAt'>

export interface TicketStore {
  // Returns the ticket, or null when unknown/expired (indistinguishable).
  lookup: (token: string) => Ticket | null
  // Returns the minted token (base64url, 256-bit).
  mint: (input: TicketInput) => string
}

const mintToken = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  // base64url, unpadded — URL-safe without further encoding.
  return Buffer.from(bytes).toString('base64url')
}

export const createTicketStore = (now: () => number = Date.now): TicketStore => {
  const tickets = new Map<string, Ticket>()

  // Lazy sweep on mint/lookup keeps the map bounded without a timer.
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
      tickets.set(token, { ...input, expiresAt: now() + TICKET_TTL_MS })
      return token
    },
  }
}
