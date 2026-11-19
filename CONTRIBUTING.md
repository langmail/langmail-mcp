# Contributing to langmail-mcp

Thank you for helping. This page covers the setup, the checks a change has
to pass and how releases happen. How the code is organized is in
`AGENTS.md`.

## Setup

You need [Bun](https://bun.sh), Node 22.12 or later for the package checks,
and [gitleaks](https://github.com/gitleaks/gitleaks), which the pre-commit
hook runs (`brew install gitleaks`).

```sh
git clone https://github.com/langmail/langmail-mcp.git
cd langmail-mcp
bun install
bun x lefthook install
```

The second command installs the git hooks: gitleaks, Biome and the typecheck
before a commit, commitlint on the message. It is not a `prepare` script,
because `npm pack` runs `prepare` and `check:package` reads `npm pack`'s
output.

## Checks

| Command | What it checks |
|---|---|
| `bun test` | The unit suite |
| `bun run typecheck` | TypeScript, for the server and the email viewer |
| `bun run check` | Biome lint and formatting (`check:fix` fixes what it can) |
| `bun run test:node` | The self-hosted tests under Node |
| `bun run check:package` | Packs the package, installs it and starts it with `npx` |
| `bun run test:integration` | The CalDAV adapter against Radicale (`AGENTS.md` § Tests against real servers) |
| `bun run test:stalwart` | Tests against the dev Stalwart in `infra/dev/stalwart` |
| `bun run spec:check` | The TLA+ model of sending (`spec/AGENTS.md`); needs Java 11 or later |

CI runs all of them on every pull request.

A change to a tool's name, description, schema or result also needs an
agent eval before and after (`docs/evals.md`), because unit tests do not show
whether an agent still picks the right tool.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make the change, with tests next to the code (`*.test.ts`).
3. Run the checks above that your change touches.
4. Open a pull request that says what changes and why.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/),
because the release version is computed from them:

- `fix:` and `refactor:` release a patch version, because the hosted server
  deploys only what is released.
- `feat:` releases a minor version.
- `feat!:` or a `BREAKING CHANGE:` footer releases a major version. Use it
  when a tool's name, inputs or outputs change in a way a client notices, or a
  setting is renamed or removed.
- `docs:`, `test:`, `chore:` and `ci:` release nothing.

## Releases

A merge to `main` runs semantic-release. It computes the next version from
the commits since the last release, publishes `langmail-mcp` to npm, creates
a GitHub release with the notes, updates `CHANGELOG.md` and builds the image
the hosted server runs. Nobody sets a version by hand.

## Questions and reports

- Bugs and feature requests: [GitHub issues](https://github.com/langmail/langmail-mcp/issues)
- Vulnerabilities: `SECURITY.md`
