# Release Process

Atlas releases when there is enough change to justify one -- not on a schedule.
There is no weekly train and no automatic version bump from commit messages. A
human decides _when_ and _what size_; everything after that decision is
automated.

## Where to target your pull request

This is the only rule most contributors need:

| You are doing                     | Branch from | Target your PR at       |
| --------------------------------- | ----------- | ----------------------- |
| A feature, fix, refactor, or docs | `dev`       | **`dev`**               |
| Cutting a release                 | `dev`       | `main` (opened for you) |
| An urgent production fix          | `main`      | `main` (opened for you) |

`dev` is the integration branch and accumulates work between releases. `main`
always reflects the newest published version. **Never open a feature PR against
`main`** -- it bypasses the accumulation model and, if it happens to carry a
version bump, publishes to npm immediately.

## What triggers a release

A release is defined by **a version bump reaching `main`**, not by the branch the
merge came from:

```
merge into main
  └─ .github/workflows/tag.yml reads packages/sdk/package.json
       ├─ tag v<version> already exists  → nothing happens
       └─ tag v<version> does not exist  → create the tag, then publish
```

This matters because merges into `main` are not all releases. A docs-only merge
landed on `main` immediately after `v2.1.0-beta`, and the `v1.2.3` tag sat on a
commit that contained no bump at all. Keying the tag on the version rather than
on the branch name makes non-release merges free and lets a hotfix use the same
path as a release without a second workflow.

The consequence to internalise: **bumping the version is the act of releasing.**
Do not bump the version in an ordinary PR.

## Cutting a release

Run the **Start release** workflow from the Actions tab (or
`gh workflow run release-start.yml -f version=2.2.0 -f from=dev`). It takes one
real input:

| Input     | Meaning                                                          |
| --------- | ---------------------------------------------------------------- |
| `version` | `2.2.0`, `2.2.0-beta.1`, or a keyword: `patch`, `minor`, `major` |
| `from`    | `dev` for a release, `main` for a hotfix                         |

The workflow then:

1. Branches `release/v<version>` from `dev` (or `hotfix/v<version>` from `main`).
2. Runs `pnpm run release:version <version>`, bumping all nine workspace
   packages in lockstep. Internal dependencies are `workspace:*`, so pnpm
   rewrites them to the exact version at publish time -- there is nothing else to
   edit.
3. Commits `chore(release): <version>` and opens a PR into `main`. The commit is
   created through GitHub's `createCommitOnBranch` GraphQL mutation rather than
   `git commit`, so GitHub signs it -- an unsigned runner commit could not be
   merged into a `main` that requires signed commits.
4. Fails early if `v<version>` is already tagged.

Review the PR, confirm CI is green, then merge it. Merging is the release.

## What happens on merge

| Step | Workflow      | Effect                                                                                       |
| ---- | ------------- | -------------------------------------------------------------------------------------------- |
| 1    | `tag.yml`     | Creates and pushes the annotated tag `v<version>`                                            |
| 2    | `publish.yml` | Re-runs build, lint, and tests, then publishes `@wisecom/atlas-sdk` and `@wisecom/atlas-cli` |
| 3    | `publish.yml` | Creates the GitHub Release with generated, categorised notes                                 |
| 4    | `tag.yml`     | Opens a back-merge PR `main` → `dev` if `main` is ahead                                      |

`publish.yml` is invoked as a reusable workflow rather than by its own
`push: tags` trigger. A tag pushed with the default `GITHUB_TOKEN` does not
trigger workflows, so relying on the tag event would silently publish nothing.
The `push: tags` trigger is retained so a manually pushed tag still publishes.

### npm dist-tags

The dist-tag is derived from the prerelease suffix, so a prerelease can never
become the default install:

| Version      | npm dist-tag | `npm install @wisecom/atlas-cli` gets it? |
| ------------ | ------------ | ----------------------------------------- |
| `2.2.0`      | `latest`     | Yes                                       |
| `2.1.0-beta` | `beta`       | No -- requires `@beta`                    |
| `2.2.0-rc.1` | `rc`         | No -- requires `@rc`                      |

GitHub Releases for prereleases are marked as prereleases automatically, on the
same rule (any `-` in the version).

## Hotfixes

A hotfix is an urgent fix that cannot wait for `dev` to be release-ready. Run
**Start release** with `from: main` and a `patch` version. It cuts
`hotfix/v<version>` from `main`, so the fix ships without dragging in unreleased
`dev` work.

Because the fix lands on `main` first, `dev` would otherwise be missing it and
the next release branch would silently revert it. `tag.yml` opens a back-merge PR
`main` → `dev` after every push to `main` where `main` is ahead. **Merge that PR
promptly** -- it is the mechanism that keeps the two branches from diverging.

## Release notes

Notes are generated by GitHub from the PRs merged since the previous tag, and
categorised by `.github/release.yml`. GitHub matches on **labels only** -- it
cannot read conventional-commit prefixes -- so an unlabelled PR lands under
"Other changes":

| Label           | Section       |
| --------------- | ------------- |
| `security`      | Security      |
| `enhancement`   | Features      |
| `bug`           | Fixes         |
| `documentation` | Documentation |
| _(none)_        | Other changes |

Label PRs as you merge them, not at release time.

## The version guard

CI runs an extra `release-guard` job on PRs from `release/**` and `hotfix/**`
branches. It fails the PR when:

- the version in the branch name disagrees with
  `packages/sdk/package.json` -- the tag would not match the branch; or
- `v<version>` is already tagged -- merging would publish nothing at all, which
  is how a release can appear to succeed while npm never changes.

Both failures print the exact `pnpm run release:version` command to fix them.

## Branch protection

`main` carries a protection rule, and the settings interact with the automation in
ways that are not obvious:

| Setting                        | State | Reason                                                                                              |
| ------------------------------ | ----- | --------------------------------------------------------------------------------------------------- |
| Require a pull request         | On    | Blocks a direct push of a version bump, which would publish to npm with no review                   |
| Require approvals              | 0     | GitHub forbids self-approval; any higher number makes release PRs unmergeable for a solo maintainer |
| Require status checks          | On    | `Build, Lint & Test`                                                                                |
| Require signed commits         | On    | Every commit in the history is signed; the release commit is API-created so it stays signed         |
| Do not allow bypassing         | On    | With bypass allowed, an admin push can still publish irreversibly -- this is what closes that hole  |
| **Require linear history**     | Off   | Tags sit on merge commits and the `main` → `dev` back-merge must be a merge commit                  |
| Allow force pushes / deletions | Off   | A force push can strand a published tag on an orphaned commit                                       |

Tag protection rules are deliberately **not** configured: a `v*` rule can block
`github-actions[bot]` from pushing the release tag, which stops every publish
silently.

## Bumping versions by hand

```bash
pnpm run release:version 2.2.0   # explicit version
pnpm run release:version patch   # 2.2.0 -> 2.2.1
```

This edits all nine `packages/*/package.json` files and nothing else -- no git
tag, no commit. Prefer the **Start release** workflow; use this only when working
offline or repairing a botched bump.

## If a publish fails

npm versions are immutable, so recovery is always forward, never a re-publish:

1. **Failed before publishing** (build, lint, or test failure): delete the tag
   (`git push --delete origin v<version>`), fix the problem on a normal PR into
   `dev`, and cut the release again with the same version.
2. **SDK published, CLI failed:** do not delete the tag. Fix forward with a
   hotfix release at the next patch version. The two packages are versioned in
   lockstep, so a partial publish must be resolved by moving both forward.
3. **Wrong dist-tag:** correct it with `npm dist-tag add` rather than
   republishing.
