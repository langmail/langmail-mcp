// True when this code runs from the repository's source tree. The
// langmail-mcp package build (scripts/build-package.ts) replaces this module
// with one that says false, so what only makes sense inside the repository
// (the dev log file under the repo's logs/) stays out of an npm install.

export const runsFromSource: boolean = true
