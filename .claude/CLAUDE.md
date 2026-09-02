# Atlas Development Rules

## This Is a Public Repository

Everything committed here is public and permanent, including commit messages,
issue and pull request text, comments, test fixtures, and documentation. Deleting
something later does not unpublish it: it stays in the history, in forks, and in
anything that mirrored it.

Never write, commit, or post:

- **Secrets.** Encryption passphrases, KEKs, DEKs, wrapped keys, S3 access and
  secret keys, client secrets, certificates, tokens, connection strings. Not in
  code, not in tests, not in a fixture, not in an example, not "obviously fake"
  in a log paste. Placeholders are `<redacted>` or the value omitted entirely.
- **Tenant or customer data.** Mailbox addresses, UPNs, display names, real file
  names, message subjects, SharePoint site URLs, drive item and message IDs,
  bucket names, tenant and client GUIDs. Substitute using the table in the
  `write-issue` skill and keep the substitution consistent so a reproduction
  still makes sense.
- **Personal information.** Names, email addresses, handles, and anything about
  who ran what and when, beyond what the committing account already shows.
- **System and environment detail.** Internal hostnames, private endpoints, VPN
  and network topology, absolute paths that carry a username, machine names, and
  full environment dumps. `./tools/diagnostics.sh` output is fine in an issue,
  but read the `ATLAS_S3_ENDPOINT` line first and drop it if the endpoint is
  private.

Sanitise pasted output line by line rather than trusting it. Atlas log lines and
`graph-tap` captures carry UPNs and site paths even though credentials are
already redacted, and a stack trace carries local filesystem paths.

Scrubbing evidence of its meaning is the other failure. Status codes, Graph
error codes, byte counts, timings, function names, and paths inside this
repository all stay: they are the diagnosis, and none of them identify anyone.

## Package Manager

Use **pnpm** exclusively. Never use npm or yarn.

```bash
pnpm install        # install deps
pnpm run build      # compile
pnpm run test       # run tests
pnpm run lint       # lint check
```

## Linting & Formatting

ESLint and Prettier rules are the source of truth. Always consult these files for current config:

- ESLint: `eslint.config.js`
- Prettier: `.prettierrc`
- TypeScript: `tsconfig.json`

Key enforced rules:

- **File names**: `kebab-case` (e.g. `mailbox-sync.service.ts`)
- **Variables / parameters**: `snake_case`
- **Types / classes**: `PascalCase`
- **Enum members**: `UPPER_CASE`
- **Functions**: `snake_case` (standalone) or `camelCase` (class methods via DI)
- **Max 300 effective lines per file** (blank lines and comments excluded)

## The 300-Line Rule

When a file approaches or exceeds 300 lines, **split the logic** into separate files. Do not compact, minify, or remove whitespace to fit. The limit exists to enforce proper separation of concerns. Extract cohesive blocks into purpose-named modules (e.g. `attachment-storage-sync.ts`, `manifest-entry-merger.ts`) rather than generic `helper` files.

## Function Design (SRP)

Every function name must describe exactly what it does, with no hidden side-effects.

- If a function does multiple things, **split it** into smaller functions and create a parent that calls them. The parent reads like an outline of the procedure.
- If the name can't fully describe the behavior, the function is too broad.

```typescript
// BAD: name hides the encryption and upload steps
async function process_message(msg: MailMessage): Promise<void> { ... }

// GOOD: parent orchestrates clearly named children
async function store_single_message(ctx: TenantContext, msg: MailMessage): Promise<ManifestEntry> {
  const checksum = compute_sha256(msg.raw_body);
  const storage_key = build_content_key(mailbox_id, checksum);
  await encrypt_and_upload(ctx, storage_key, msg);
  return build_manifest_entry(msg, storage_key, checksum);
}
```

## Imports

Never use relative imports. Always use the `@/` path alias defined in `tsconfig.json`:

```typescript
// BAD
import { logger } from '../../utils/logger';

// GOOD
import { logger } from '@/utils/logger';
```

## Architecture: Hexagonal + DI

The project follows hexagonal architecture with Inversify for dependency injection.

```
src/
  domain/       Pure data models, no dependencies
  ports/        Interfaces and tokens (input + output ports)
  services/     Application logic, depends only on ports
    backup/
    restore/
    verification/
    catalog/
    deletion/
    shared/
  adapters/     Concrete implementations of ports
  cli/          Incoming adapters (commands, presenters, signal handling)
  utils/        Small helpers (logging, config)
```

- **Services** depend on **port interfaces**, never on adapter implementations or CLI concerns.
- **Adapters** implement port interfaces and are bound in `container.ts`.
- **CLI commands** resolve **incoming use-case ports** from the DI container and delegate.
- Presentation/runtime concerns (`chalk`, dashboards, signal handling, process control) belong in CLI adapters/presenters, not application services.
- Keep `src/services/` organized by deterministic capability subfolders; avoid root-level sprawl.
- Do not use ambiguous `*.helper.ts` names in services. Use behavior-revealing names (e.g. `folder-sync-executor.ts`, `restore-message-transformer.ts`).
- Keep root public exports core-only; do not re-export infrastructure adapters from `src/index.ts`.
- Workload packages lay their services out by capability, the same way in every package: `services/backup`, `services/restore`, `services/save`, `services/verification`, `services/catalog`, `services/versioning`, `services/status`, `services/shared`. The folder carries the context, so the filename never repeats the package name (`services/backup/backup.service.ts`, not `services/onedrive-backup.service.ts`).
- A `services/index.ts` barrel is the package's cross-package surface: the service classes other packages resolve from the container, plus the few helpers another package actually imports. Anything used only inside its own package is reached by path and never widened into the barrel. `packages/outlook` exports `parse_mime_message` because the CLI renders MIME; `packages/onedrive` exported storage-key and download helpers that nothing outside the package ever imported, which is the pattern to avoid.
- `core`, `types`, and the other private workspace packages keep the `./*` wildcard in their export map. They are never published, so the wildcard exposes nothing outside this repository, and the 200-odd deep imports into `@wisecom/atlas-core/services/...` are the normal way to reach them. Dropping the wildcard would rewrite every one of those imports and buy no encapsulation, so the root `index.ts` stays a convenience entry point rather than a gate.
- Code that OneDrive and SharePoint would otherwise hold two copies of belongs in `packages/drive`, not in `core` and not duplicated. The two providers differ in values, not behavior: manifest prefix, whether the owning segment is a drive owner or a site, and the connector's name. Shared code takes those as a parameter and stays generic over the manifest type. `core` is the wrong home for it because the shared drive code needs `@wisecom/atlas-m365-graph`, and core must not depend on an adapter package.
- All injectable classes use `@injectable()` and `@inject()` decorators.

## Testing

Maintain high test coverage on all business-critical logic.

- Test framework: **Vitest** with `@vitest/coverage-v8`
- Config: `vitest.config.ts`
- Test location: `tests/unit/` mirroring `src/` structure
- Each service and adapter should have dedicated test files
- When test files approach 300 lines, extract into focused test files (e.g. `delta-safeguard.test.ts`, `attachment-sync.test.ts`)
- Mock port interfaces in tests, never real adapters
- Run tests: `pnpm run test`
- `pnpm run typecheck` runs `tsc --noEmit -p tsconfig.test.json`, which covers `src` **and** `tests`. Vitest does not typecheck, so a mock that has drifted from its port is only caught here. Build already typechecks `src`, so never point `typecheck` back at `tsconfig.json`.
- Port stubs belong in `packages/types/src/testing/`, imported as `@wisecom/atlas-types/testing/<helper>`. Do not hand-roll crypto or context stubs per test file.

## JSDoc

Add JSDoc to all exported functions and public class methods. Keep it to one line when the name is already descriptive. Only add multi-line JSDoc when the behavior is non-obvious.

## Build Cache

`turbo.json` declares `tsconfig.tsbuildinfo` as a `build` output alongside `dist/**`. Composite `tsc` writes it to the package root, and if it desyncs from the cached `dist/`, `tsc` reports "up to date" and silently skips emitting stale `.d.ts` files. Never remove it from `outputs`.

## Documentation Governance

Every change that affects user-visible behavior must include corresponding documentation updates in the same PR:

- New or changed CLI flags/options → update `docs/reference/cli.md`
- New or changed SDK methods/options → update `docs/reference/sdk.md`
- Configuration changes → update `docs/configuration.md`
- Security or encryption changes → update `docs/security.md`
- Self-hosting, storage, or infrastructure changes → update `docs/self-hosting.md`
- New commands or features → add to the relevant docs page and update the sidebar in `docs/.vitepress/config.ts`
- Developer tooling under `tools/` → document under `docs/development/`, not `docs/operations/`
- README quick-start or highlights affected → update `README.md`

### Writing Style

- **No dashes as punctuation**: never use an em dash (—) or `--` inside a phrase in prose. Rewrite the sentence instead: split it in two, use a comma, or restructure. This applies to docs, README, CONTRIBUTING, and PR descriptions. It does not apply to CLI flags, code, or YAML.
- **Do not over-explain**: state the fact once. No restating the heading, no throat-clearing intro, no defending an obvious choice. If a paragraph can be cut without losing information, cut it.
- **Explanatory IT tone**: write for IT administrators and security-conscious operators who need to understand why things work the way they do, not just what to type. Assume the reader is technical but unfamiliar with Atlas internals.
- **Cybersecurity awareness**: explain security implications where relevant: why encryption parameters were chosen, what threat models are addressed, what the attack surface looks like, and what happens if credentials are compromised.
- **Implementation-grounded**: ground behavior in the actual implementation. Cite specific parameters (scrypt N=16384), algorithms (AES-256-GCM), retry counts (12 attempts), and defaults rather than hand-waving.
- **Self-hosting and operations**: include storage, scheduling, credentials management, platform recommendations, and network or bandwidth considerations where relevant.
- **Examples first**: lead sections with a working code or CLI example, then explain options and behavior.
- **Concise**: one idea per paragraph. Prefer tables for option and flag references. Avoid walls of prose.
- **Consistent structure**: every CLI command page follows the pattern description, examples, options table, then details.
- **No jargon without context**: if a term (KEK, DEK, delta link, Object Lock) is needed, define it on first use or link to the relevant docs page.

### Pre-Merge Checklist

1. All changed commands/options are reflected in `docs/reference/cli.md`
2. All changed SDK methods are reflected in `docs/reference/sdk.md`
3. All changed config variables are reflected in `docs/configuration.md`
4. The VitePress sidebar in `docs/.vitepress/config.ts` includes any new pages
5. `pnpm run docs:build` succeeds without warnings
6. Security-sensitive changes include updated threat model or risk notes in `docs/security.md`
7. Prose contains no em dashes and no `--` used as punctuation
8. Brand assets stay covered by `assets/LICENSE.md`, which is deliberately not Apache-2.0
9. `packages/sdk/README.md` and `packages/cli/README.md` are current, since npm renders them as the package page
10. The diff, the commit messages, and the PR text carry no secrets, tenant data, personal information, or internal system detail, per [This Is a Public Repository](#this-is-a-public-repository)
