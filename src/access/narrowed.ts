// What a narrowed tool needs at Change, never send (src/access/levels.ts): the
// event and rule writers register a form there that refuses a stored event or
// rule that already reaches other people, and the refusal says where the user
// changes the level.

import { type ServerMode } from '../mode.ts'

// Set on a narrowed tool's handler context; absent at Everything.
export interface Narrowed {
  mode: ServerMode
}

// Where the user changes the level: the self-hosted --access option, or the
// Access page in Langmail (langmail/platform#1452; until it exists every
// hosted connection runs at Everything, src/auth/middleware.ts).
export const whereToChange = (mode: ServerMode): string =>
  mode === 'self-hosted' ? 'by restarting the server with the --access option' : 'under Access in Langmail'

// The refusal for a stored object that already reaches other people: `what`
// says what that object is, `needs` names the kind that needs Everything.
export const needsEverything = (what: string, needs: string, mode: ServerMode): string =>
  `${what} Nothing was changed. ${needs} need Everything access, which the user can set ${whereToChange(mode)}.`
