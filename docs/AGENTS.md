# docs/

Two kinds of files live here:

- **The site at docs.langmail.me**: the `.mdx` pages, `docs.json`
  (navigation, theme, settings), `logo/` and `favicon.svg`, built with
  [Mintlify](https://mintlify.com).
- **Internal docs** for this repository: every `.md` file, including this
  one, and `upstream/`. `.mintignore` keeps them off the site, so an internal
  doc is always `.md` and a site page always `.mdx`.

The rules below are for the site.

## Commands

Run from the repository root:

```sh
bun run docs:dev       # the site on http://localhost:3000, with live reload
bun run docs:validate  # strict build validation (docs.json schema, MDX)
bun run docs:links     # internal link check
```

Both checks must pass before merging a change to the site. CI runs them on
changes under `docs/` (`.github/workflows/docs-validate.yml`). The `mint`
version is pinned in the three scripts in the root `package.json`: bump them
together.

## Conventions

- `docs.json` (navigation) and the `.mdx` page tree are the source of truth
  for the site's structure. Page URLs follow the file paths.
- Document only what exists in the code. The tool reference
  (`reference/mcp/<tool>.mdx`) describes the hosted server and mirrors the
  tools in `src/tools/`, whose definitions
  `src/mcp/__snapshots__/tool-surface.test.ts.snap` pins. A tool change
  updates its page, its nav entry in `docs.json` and the overview
  (`reference/mcp/overview.mdx`: the index, the tool count, the annotation
  table and the access levels) in the same pull request. Self-hosted
  differences belong in `self-hosted.md`.
- Every page needs `title` and `description` frontmatter (`description`
  feeds SEO and the generated `llms.txt`).
- Voice: calm, exact, no hype; second person; sentence-case headings.
- Do not hand-author `llms.txt`: Mintlify generates it.

## Deployment

The Mintlify GitHub App deploys the site from `main` on push. Account setup,
the app's installation and the `docs.langmail.me` DNS are one-time manual
steps outside this repository.
