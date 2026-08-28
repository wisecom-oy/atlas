---
name: release
description: >-
  Cut, verify, or repair an Atlas release. Covers version bumps, the release and
  hotfix branch flow, tag creation, the npm publish pipeline, and recovery from a
  failed or partial publish.
when_to_use: >-
  Use whenever the user asks to release, ship, cut, publish, tag, or bump a
  version, to prepare a beta or release candidate, to hotfix production, or asks
  what is in the next release or why a publish did not happen.
---

# Releasing Atlas

The rule: **a release is a version bump reaching `main`.** Nothing else tags,
and nothing else publishes. Releases happen when there is enough change to
justify one -- never on a schedule, never automatically from commit messages.

Full reference for humans: `docs/development/releases.md`. This skill is the
operational procedure.

## Hard rules

1. **Never bump a version outside a release or hotfix PR.** The bump _is_ the
   release trigger. A bump merged in an ordinary PR publishes to npm on arrival.
2. **Never hand-edit the nine `packages/*/package.json` versions.** Use
   `pnpm run release:version <version>`. They move in lockstep; a partial bump
   fails the publish workflow's tag/version check.
3. **Never delete a tag whose npm publish already succeeded.** npm versions are
   immutable. Recovery is always forward, at the next patch version.
4. **Never reuse a version.** If `v<version>` is tagged, that version is spent.
5. **Do not push a tag by hand** unless repairing a broken run. `publish.yml`
   owns tag creation; a hand-pushed tag that does not match the packages fails.
6. **Never create the release commit with `git commit` in CI.** `main` requires
   signed commits; the workflow uses GitHub's `createCommitOnBranch` mutation so
   the commit is signed. A runner-side `git commit` produces an unsigned commit
   and an unmergeable release PR.
7. **Never split tagging out of `publish.yml`.** npm auth is OIDC trusted
   publishing with no `NPM_TOKEN`, and npm validates the entry-point workflow. A
   `workflow_call` hop makes the caller the entry point and the publish dies with
   `ENEEDAUTH` after the tag is already pushed.
8. **Never add `pull_request` or `push` to `e2e.yml`.** It holds tenant
   credentials, costs tens of minutes, and gates nothing. Nightly cron plus
   manual dispatch only.

## Which flow applies

| Situation                                | Flow    | Cut from |
| ---------------------------------------- | ------- | -------- |
| Enough accumulated work on `dev` to ship | Release | `dev`    |
| Urgent fix that cannot wait for `dev`    | Hotfix  | `main`   |
| A published release is broken            | Hotfix  | `main`   |

## Cutting a release

Before anything, establish what is actually unreleased. Do not trust the
changelog or the roadmap:

```bash
git fetch --all --tags
git log --oneline "$(git describe --tags --abbrev=0 origin/main)"..origin/dev
node -p "require('./packages/sdk/package.json').version"
git tag --sort=-creatordate | head -5
```

Choose the version from the nature of those commits: breaking change → major,
new capability → minor, fixes only → patch. Prereleases use `-beta`, `-beta.N`,
or `-rc.N` and publish under a matching npm dist-tag, never `latest`.

Then trigger the workflow -- do not create the branch or the bump by hand:

```bash
gh workflow run release-start.yml -f version=2.2.0 -f from=dev
gh run watch
```

It creates `release/v<version>`, bumps all nine packages, commits
`chore(release): <version>`, and prints a prefilled compare link in the run
summary. The organisation forbids GitHub Actions from creating pull requests, so
open the release PR from that link:

```bash
gh run view --job "$(gh run list --workflow release-start.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --log | grep 'compare/main'
gh pr create --base main --head "release/v<version>" --title "chore(release): <version>" --body '...'
```

Before merging:

- Confirm CI is green, including the `release-guard` job.
- Confirm every PR in the release carries a label (`enhancement`, `bug`,
  `documentation`, `security`) -- notes are categorised by label only, and
  unlabelled PRs land under "Other changes".
- Confirm the docs governance checklist in `.claude/CLAUDE.md` is satisfied for
  everything in the release: CLI flags, SDK methods, config variables, and
  security changes all have documentation in place.

Merging the PR is the release. Then watch the pipeline:

```bash
gh run watch                                    # publish.yml: plan, publish, sync-dev
npm view @wisecom/atlas-sdk dist-tags
npm view @wisecom/atlas-cli dist-tags
```

## Hotfixes

```bash
gh workflow run release-start.yml -f version=patch -f from=main
```

The fix itself goes on the generated `hotfix/v<version>` branch, which is cut
from `main`, so unreleased `dev` work does not ship with it.

**After the hotfix publishes, confirm the `sync-dev` job fast-forwarded `dev` onto
`main`.** If `dev` had diverged the push is refused and the job fails -- merge
`main` into `dev` by hand at that point. Skipping it means the next release
branch is cut from a `dev` that lacks the fix, silently reverting it.

E2E does not run per PR. Before a release, check the most recent nightly rather
than blocking on a fresh run: `gh run list --workflow e2e.yml --limit 3`. Dispatch
one explicitly with `gh workflow run e2e.yml` when the release touches backup,
restore, or storage behaviour.

## Verifying a release actually shipped

A release can appear to succeed while nothing was published. Check all four:

```bash
git ls-remote --tags origin | grep "v<version>"     # tag exists
npm view @wisecom/atlas-sdk@<version> version       # sdk published
npm view @wisecom/atlas-cli@<version> version       # cli published
gh release view "v<version>"                        # notes generated
```

The dist-tag must match the version shape: no `-` → `latest`; `-beta` → `beta`;
`-rc.N` → `rc`. A prerelease sitting on `latest` is a production incident --
correct it with `npm dist-tag add`, never by republishing.

## When a release did not happen

| Symptom                                | Cause                                                     | Fix                                                |
| -------------------------------------- | --------------------------------------------------------- | -------------------------------------------------- |
| Merged to `main`, no tag               | Version was already tagged -- no bump in the merge        | Cut a real release with a higher version           |
| `release-guard` fails on branch name   | Branch version disagrees with `packages/sdk/package.json` | `pnpm run release:version <branch version>`        |
| `release-guard` fails on existing tag  | Version already released                                  | Pick a higher version                              |
| Tag exists, `publish.yml` never ran    | Tag pushed by hand with `GITHUB_TOKEN`                    | `gh workflow run publish.yml -f version=<version>` |
| No `publish.yml` run at all             | GitHub created no run for the push (issue #212)           | `gh workflow run publish.yml -f version=<version> --ref main`; it tags the ref when the tag is missing |
| Publish failed on build, lint, or test | Broken release commit                                     | Delete the tag, fix via a PR into `dev`, cut again |
| SDK published, CLI failed              | Partial publish; npm is immutable                         | Hotfix forward at the next patch version           |

## Repairing a botched bump

```bash
pnpm run release:version 2.2.0        # explicit version, all nine packages
pnpm run release:version patch        # or a keyword
git diff --stat                       # expect exactly 9 package.json files
```

Nine files and nothing else. Internal dependencies are `workspace:*` and are
rewritten by pnpm at publish time, so they never need editing. If the diff shows
a different count, stop -- a package was added or the filter is wrong.
