// What a narrowed tool needs at Change, never send (src/access/levels.ts): the
// event and rule writers register a form there that refuses a stored event or
// rule that already reaches other people, and the refusal says where the user
// changes the level.

import { type ServerMode } from '../mode.ts'

// Set on a narrowed tool's handler context; absent at Everything.
export interface Narrowed {
  mode: ServerMode
}

// Where the user changes the level. Neither place exists yet: the self-hosted
// --access option comes with langmail/platform#1450 and the Access page with
// the Langmail slices of #1447. Until then every connection runs at
// Everything, so no agent reads this.
export const whereToChange = (mode: ServerMode): string =>
  mode === 'self-hosted' ? 'by restarting the server with the --access option' : 'under Access in Langmail'

// The refusal for a stored object that already reaches other people: `what`
// says what that object is, `needs` names the kind that needs Everything.
export const needsEverything = (what: string, needs: string, mode: ServerMode): string =>
  `${what} Nothing was changed. ${needs} need Everything access, which the user can set ${whereToChange(mode)}.`
