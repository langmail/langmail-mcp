# Contributing to langmail-mcp

Thank you for contributing to langmail-mcp! This guide will help you get started.

## Development Setup

1. **Prerequisites**: Node.js >= 22, [gitleaks](https://github.com/gitleaks/gitleaks) (used by the pre-commit hook; `brew install gitleaks`)
2. **Clone and install**:
   ```bash
   git clone https://github.com/langmail/langmail-mcp.git
   cd langmail-mcp
   npm install
   ```
3. **Configure environment**: Copy `.env.example` to `.env` and add credentials
4. **Build**: `npm run build`
5. **Verify**: `node --env-file=.env dist/index.js` should start and wait for an MCP client on stdio

## Development Workflow

### Making Changes
1. Create a feature branch from a freshly fetched `main`: `git fetch && git switch --no-track -c feat/your-feature origin/main`
2. Make changes in `src/`
3. Write/update tests next to the code (`src/**/*.test.ts`)
4. Validate your changes: `npm run validate`
5. Commit with conventional format (see below)

### Running Tests
- `npm test` - Run all tests
- `npm run test:watch` - Watch mode for TDD
- `npm run test:coverage` - Check coverage (aim for >70%)
- `npm run test:e2e` - Run the `e2e/` suites against a real Stalwart (see `e2e/README.md`)

### Code Quality
- Pre-commit hooks automatically run Biome checks and tests
- Use `npm run check` to check for issues
- Use `npm run check:fix` to auto-fix issues
- Run `npm run validate` before pushing (checks, tests, and build)

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/) for automated versioning:

- `feat:` - New features (minor version bump)
- `fix:` - Bug fixes (patch version bump)
- `docs:` - Documentation only
- `test:` - Test additions/changes
- `chore:` - Maintenance tasks
- `refactor:` - Code refactoring
- `perf:` - Performance improvements
- `BREAKING CHANGE:` - Breaking changes (major version bump)

**Examples:**
```
feat: add support for recurring events
fix: handle HTTP 204 in delete_calendar_event
docs: update AGENTS.md with new scripts
test: add tests for create_draft tool
```

## Pull Request Process

1. **Fork** the repository
2. **Create a branch** from `main`
3. **Make changes** following guidelines above
4. **Run validation**: `npm run validate` (must pass)
5. **Push** to your fork
6. **Create PR** with clear description
7. **Wait for CI** - All checks must pass (lint, format, tests)
8. **Address feedback** if requested

## Testing Guidelines

- **Write tests for new features**: Add tests alongside new code
- **Mock external dependencies**: Tools take their dependencies as an argument; pass fakes built with `vi.fn()`
- **Test error cases**: Include happy path and error scenarios
- **Follow existing patterns**: See the `*.test.ts` files in `src/tools/`
- **Use `example.com` addresses** in all test data; never real people or hosts

**Example test structure:**
```typescript
import { describe, expect, test, vi } from "vitest";

describe("registerYourTool", () => {
  test("successfully handles valid input", async () => {
    const deps = {
      yourMethod: vi.fn().mockResolvedValue({ ... }),
    };
    // ... test implementation
  });

  test("handles errors gracefully", async () => {
    const deps = {
      yourMethod: vi.fn().mockRejectedValue(new Error("Test error")),
    };
    // ... test error handling
  });
});
```

## Code Style

- **TypeScript strict mode** - Required
- **Biome** - Unified linting and formatting enforced via pre-commit hooks
- **No `any` types** - Use proper typing
- **Error handling** - Always wrap async operations in try-catch
- **Descriptive names** - Clear function and variable names

## Release Process

Releases are fully automated via semantic-release:

1. **Merge to main** triggers CI/CD
2. **semantic-release** analyzes commit messages
3. **Version bumped** based on conventional commits
4. **CHANGELOG.md** automatically updated
5. **NPM package** published
6. **GitHub release** created with notes

**You don't need to manually version or release!**

## Questions or Issues?

- **Bug reports**: [GitHub Issues](https://github.com/langmail/langmail-mcp/issues)
- **Questions**: [GitHub Discussions](https://github.com/langmail/langmail-mcp/discussions)
- **Security issues**: See [SECURITY.md](SECURITY.md)

Thank you for contributing! 🎉
