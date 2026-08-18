# Documentation Governance

## Docs Must Stay In Sync

Every change that affects user-visible behavior must include corresponding documentation updates in the same PR:

- New or changed CLI flags/options → update `docs/reference/cli.md`
- New or changed SDK methods/options → update `docs/reference/sdk.md`
- Configuration changes → update `docs/configuration.md`
- Security or encryption changes → update `docs/security.md`
- Self-hosting, storage, or infrastructure changes → update `docs/self-hosting.md`
- New commands or features → add to the relevant docs page and update sidebar in `docs/.vitepress/config.ts`
- README quick-start or highlights affected → update `README.md`

## Writing Style

- **Explanatory IT tone**: write for IT administrators and security-conscious operators who need to understand WHY things work the way they do, not just WHAT to type. Assume the reader is technical but unfamiliar with Atlas internals.
- **Cybersecurity awareness**: explain security implications where relevant -- why encryption parameters were chosen, what threat models are addressed, what the attack surface looks like, and what happens if credentials are compromised.
- **Implementation-grounded**: when describing a behavior, ground it in the actual implementation -- cite specific parameters (e.g. scrypt N=16384), algorithms (AES-256-GCM), retry counts (12 attempts), and defaults rather than hand-waving.
- **Self-hosting and operations**: include storage, scheduling, credentials management, platform recommendations, and network/bandwidth considerations where relevant.
- **Examples first**: lead sections with a working code or CLI example, then explain options and behavior.
- **Concise**: one idea per paragraph. Prefer tables for option/flag references. Avoid walls of prose.
- **Consistent structure**: every CLI command page follows the pattern: description → examples → options table → tips/details.
- **No jargon without context**: if a term (KEK, DEK, delta link, Object Lock) is needed, define it on first use or link to the relevant docs page.

## Pre-Merge Checklist

Before merging, verify:

1. All changed commands/options are reflected in `docs/reference/cli.md`
2. All changed SDK methods are reflected in `docs/reference/sdk.md`
3. All changed config variables are reflected in `docs/configuration.md`
4. VitePress sidebar in `docs/.vitepress/config.ts` includes any new pages
5. `pnpm run docs:build` succeeds without warnings
6. Security-sensitive changes include updated threat model or risk notes in `docs/security.md`
