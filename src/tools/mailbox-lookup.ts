// One folder-name lookup shared by every tool that takes a `mailbox`
// argument (search_emails' filter, move_emails' destination): a place name
// resolves by role, anything else by exact name, and a miss carries the
// account's folder names so the error can say what *does* exist — a bare
// "not found" on a folder whose server-side name differs from the place name
// (Stalwart calls the sent mailbox "Sent Items") reads as "those messages
// were never synced". Never creates.

import { type MailboxIdByNameParams, mailboxIdByNameOrRole, mailboxNames } from '@langmail/jmap'

export interface MailboxLookup {
  // Empty on a hit — the listing is only fetched when there's an error to write.
  available: string[]
  id: string | null
}

export const lookupMailbox = async (
  call: Omit<MailboxIdByNameParams, 'name'>,
  name: string
): Promise<MailboxLookup> => {
  const id = await mailboxIdByNameOrRole({ ...call, name })
  // The folder listing is only worth a round-trip when the lookup missed.
  return { available: id ? [] : await mailboxNames(call), id }
}
