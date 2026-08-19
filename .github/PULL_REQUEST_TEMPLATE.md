<!--
Target `dev` unless this is a release or a hotfix. Merging a version bump into
`main` tags and publishes to npm -- see docs/development/releases.md.
Add a label (enhancement / bug / documentation / security) so the generated
release notes are categorised.
-->

## Summary

<!-- What does this PR do? Link related issues with "Closes #123". -->

## Changes

<!-- Bullet-point list of what changed and why. -->

-

## Checklist

- [ ] `pnpm run build` passes
- [ ] `pnpm run lint` passes with no new errors
- [ ] `pnpm run test` passes with no regressions
- [ ] New/changed code has unit tests
- [ ] JSDoc added to exported functions and public methods
- [ ] No file exceeds 300 effective lines
- [ ] No relative imports (use `@/` path aliases)
- [ ] Secrets and credentials are not committed
- [ ] Targets `dev` (not `main`), unless this is a release or hotfix PR
- [ ] No version bump in `packages/*/package.json` (releases only)
- [ ] Labelled for release notes (`enhancement`, `bug`, `documentation`, `security`)
