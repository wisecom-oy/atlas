# Contributing to Atlas

This guide covers setup, code conventions, the architecture, and what a pull request needs.

## Prerequisites

- **Node.js** 20 or later
- **pnpm** (never npm or yarn)
- **Docker** (optional, for running MinIO locally)

## Getting started

```bash
# clone and install
git clone https://github.com/wisecom-oy/atlas.git
cd atlas
pnpm install

# start local MinIO (S3-compatible storage)
cd docker && docker compose up -d && cd ..

# copy and fill in environment variables
cp .env.example .env

# verify everything works
pnpm run build
pnpm run lint
pnpm run test
```

## Development workflow

`dev` is the integration branch and accumulates work until there is enough for a
release. `main` always reflects the newest version published to npm.

1. Create a branch from `dev` for your change.
2. Make your changes following the conventions below.
3. Run the full quality gate before pushing:

```bash
pnpm run build
pnpm run lint
pnpm run format:check
pnpm run test
```

4. Open a pull request against **`dev`**. CI will run the same checks automatically.

### Where to target your PR

| You are doing                     | Branch from | Target your PR at       |
| --------------------------------- | ----------- | ----------------------- |
| A feature, fix, refactor, or docs | `dev`       | **`dev`**               |
| Cutting a release                 | `dev`       | `main` (opened for you) |
| An urgent production fix          | `main`      | `main` (opened for you) |

Never open a feature PR against `main`. Merging a version bump into `main` is what
tags and publishes a release, so anything landing there is treated as a release or
a hotfix.

### Do not bump the version in a normal PR

Version bumps belong to release PRs, which are created by the **Start release**
workflow. Bumping `packages/*/package.json` in an ordinary PR publishes to npm the
moment it reaches `main`. See [Release Process](./docs/development/releases.md) for
how releases are cut, how hotfixes work, and how release notes are categorised.

### Label your PR

Release notes are generated from PR labels (`enhancement`, `bug`,
`documentation`, `security`). An unlabelled PR shows up under "Other changes", so
label it before it is merged.

### Write the PR description

`.github/PULL_REQUEST_TEMPLATE.md` is the shape of every PR body:

- **`## Summary`**: what the PR does and why, in plain sentences. Link the
  issue it fixes with `Closes #N`.
- **`## Changes`**: concrete bullets, one per thing you changed.
- **`## Checklist`**: tick what you actually ran.

Extra sections below those are welcome, and a larger PR usually wants one for
evidence or for the option it did not take. Delete the template's HTML comments
and placeholder bullets rather than leaving them in.

Write it in the first person and keep it factual. Claim only what you ran, name
what you did not verify, and follow the same prose rules as the docs: no em
dashes, no `--` inside a phrase, no padding. The `write-comment` skill in
`.claude/skills/` covers the voice in detail and applies to PR bodies too.

This section and the `write-comment` skill are the baseline. The
`Changes explained` pre-merge check in `.coderabbit.yaml` restates it, so when
the convention changes here, update the check to match rather than the other way
around.

## Code conventions

Atlas enforces conventions via ESLint and Prettier. The linter config in `eslint.config.js` is the source of truth.

| Rule                                                 | Enforced by                            |
| ---------------------------------------------------- | -------------------------------------- |
| `kebab-case` file names                              | `eslint-plugin-check-file`             |
| `snake_case` variables, parameters, properties       | `@typescript-eslint/naming-convention` |
| `PascalCase` types, classes, interfaces              | `@typescript-eslint/naming-convention` |
| `UPPER_CASE` enum members                            | `@typescript-eslint/naming-convention` |
| Max 300 effective lines per file                     | `max-lines` ESLint rule                |
| Single quotes, trailing commas, 100-char print width | Prettier                               |
| `@/` path aliases (no relative imports)              | `tsconfig.json` paths                  |
| JSDoc on all exported functions                      | Convention                             |

**SDK exception:** Files under `src/sdk.ts`, `src/ports/atlas/`, and `src/adapters/sdk/` use standard ES6 `camelCase` naming to provide a familiar interface for external consumers. This is configured as an ESLint override.

### The 300-line rule

When a file approaches 300 lines, split the logic into smaller, purpose-named files. Do not compact code to fit. The limit enforces separation of concerns.

### Function design

Every function name must describe exactly what it does. If a function does multiple things, split it into focused children and a parent that reads like an outline. No hidden side-effects.

### Imports

Always use the `@/` path alias. Never use relative imports:

```typescript
// good
import { logger } from '@/utils/logger';

// bad
import { logger } from '../../utils/logger';
```

## Architecture

Atlas follows hexagonal architecture (ports and adapters) with Inversify for dependency injection.

```
src/
  domain/       Pure data models, no dependencies
  ports/        Interfaces and tokens (input + output ports)
  services/     Application logic, depends only on ports
  adapters/     Concrete implementations of ports
  cli/          CLI incoming adapter (commands, presenters)
  utils/        Small helpers (logging, config)
```

Key rules:

- **Services** depend on port interfaces only, never on adapters or CLI concerns.
- **Adapters** implement port interfaces and are bound in `container.ts`.
- **CLI commands** and the **SDK adapter** are incoming adapters that resolve use-case ports from the DI container.
- Presentation concerns (chalk, dashboards, signal handling) belong in CLI adapters, not services.

## Testing

- Framework: **Vitest** with `@vitest/coverage-v8`
- Test location: `tests/unit/` mirroring the `src/` structure
- Mock port interfaces in tests, never real adapters
- Each service and adapter should have dedicated test files
- No network calls in unit tests

```bash
pnpm run test           # run tests
pnpm run test:watch     # watch mode
pnpm run test:coverage  # with coverage report
```

## Pull request guidelines

- Keep PRs focused on a single concern.
- Include unit tests for new or changed behavior.
- Fill in the PR template checklist.
- Make sure CI passes before requesting review.
- Avoid committing secrets, credentials, or `.env` files.

## Reporting issues

Use the GitHub issue templates:

- **Bug report**: unexpected behavior, crashes, or incorrect results.
- **Feature request**: new capabilities or improvements.

For bug reports, paste the output of `./tools/diagnostics.sh` into the Environment
section. It collects the OS, kernel, Node and pnpm versions, Atlas version, git
branch and commit, Docker version, and which configuration sources are present. It
never prints secret values.

Scrub real tenant data first. Mailbox addresses, display names, file names, message
subjects, and site URLs must be replaced with generic equivalents
(`john.doe@example.com`, `John Doe`, `contoso.sharepoint.com`) before posting.
Keep error codes and stack traces intact. They are the diagnosis.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE).
