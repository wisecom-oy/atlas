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
  └─ .github/workflows/publish.yml reads packages/sdk/package.json
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
3. Commits `chore(release): <version>` on that branch. The commit is created
   through GitHub's `createCommitOnBranch` GraphQL mutation rather than
   `git commit`, so GitHub signs it -- an unsigned runner commit could not be
   merged into a `main` that requires signed commits.
4. Fails early if `v<version>` is already tagged.
5. Prints a compare link with the PR title and body prefilled, in the run summary.

Follow that link to open the release PR, confirm CI is green, then merge it.
Merging is the release.

## What happens on merge

| Step | Job        | Effect                                                                                       |
| ---- | ---------- | -------------------------------------------------------------------------------------------- |
| 1    | `plan`     | Creates and pushes the annotated tag `v<version>`                                            |
| 2    | `publish`  | Re-runs build, lint, and tests, then publishes `@wisecom/atlas-sdk` and `@wisecom/atlas-cli` |
| 3    | `publish`  | Creates the GitHub Release with generated, categorised notes                                 |
| 4    | `sync-dev` | Fast-forwards `dev` onto `main` if `main` is ahead                                           |

All four jobs live in `publish.yml`, and that is not incidental. npm authentication
is OIDC trusted publishing -- there is no `NPM_TOKEN` secret -- and npm validates the
**entry-point** workflow, not the workflow that runs `npm publish`. An earlier design
split tagging into `tag.yml` and called `publish.yml` via `workflow_call`; that made
`tag.yml` the entry point, npm stopped matching the trusted publisher, and the
publish failed with `ENEEDAUTH` _after_ the tag had already been pushed. Keep tagging
and publishing in one file.

Collapsing them also removes the reason the split existed: a tag pushed with the
default `GITHUB_TOKEN` does not trigger workflows, so a separate tagging workflow
could never have triggered the publish through the tag event at all.

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
the next release branch would silently revert it. The `sync-dev` job in
`publish.yml` therefore pushes `main` onto `dev` after every push to `main` where
`main` is ahead.

That push is a fast-forward, which is the normal case: a release or hotfix merge
leaves `dev` strictly behind `main`. If `dev` has diverged -- someone landed work
on `dev` between the hotfix merge and the sync -- the push is refused and the job
**fails loudly** with a compare link. Merge `main` into `dev` by hand at that
point; a job that skipped quietly would let the next release revert a shipped fix.

The organisation forbids GitHub Actions from creating pull requests
(`can_approve_pull_request_reviews` is disabled org-wide and a repository cannot
override it), which is why this is a direct push rather than a back-merge PR, and
why **Start release** hands back a prefilled compare link instead of opening the
release PR itself.

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

## When each workflow runs

CI minutes are not free and a live-tenant suite costs Graph quota, so every trigger
is deliberately narrow:

| Workflow            | Runs on                                            | Notes                                                |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `ci.yml`            | Pull requests into `main`, `dev`, `release/**`     | Superseded runs on the same branch are cancelled     |
| `publish.yml`       | Push to `main`, a pushed `v*` tag, manual dispatch | Only actually publishes when the version is untagged |
| `e2e.yml`           | Nightly cron at 03:00 UTC, manual dispatch         | Never per push or per PR                             |
| `release-start.yml` | Manual dispatch only                               | —                                                    |
| `docs.yml`          | Push to `main` touching `docs/**`                  | —                                                    |

`ci.yml` has no `push` trigger. Both `main` and `dev` require a pull request, so a
push trigger only re-ran the identical commit a second time -- PR #126 produced two
`Build, Lint & Test` rows for one change. The merged result is still covered,
because `publish.yml` re-runs build, lint, and tests before anything reaches npm.

It runs two jobs in parallel. `Build, Lint & Test` covers the TypeScript packages.
`E2E suite lint, format & types` runs `ruff` and `mypy` over `e2e/`, holding the
Python that drives the shipped CLI to the same standard as the TypeScript it drives.
That job needs no secrets and no tenant, which is why static analysis of the suite
gates every pull request while the suite itself stays nightly.

`e2e.yml` no longer runs per push. It takes tens of minutes against a live tenant
and gates nothing, so a nightly run is enough. Dispatch it explicitly when a change
touches backup, restore, or storage behaviour and you want an answer sooner:

```bash
gh workflow run e2e.yml                          # everything
gh workflow run e2e.yml -f suite='object_lock'   # one suite
```

Before cutting a release, check the most recent nightly rather than waiting on a
fresh run:

```bash
gh run list --workflow e2e.yml --limit 3
```

## Branch protection

`main` is governed by a repository **ruleset** (not classic branch protection --
`/branches/main/protection` returns 404, the rules live under
`/repos/:owner/:repo/rulesets`). The settings interact with the automation in ways
that are not obvious:

| Rule                       | State | Reason                                                                                               |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| Require a pull request     | On    | Blocks a direct push of a version bump, which would publish to npm with no review                    |
| Required approvals         | 0     | GitHub forbids self-approval; any higher number makes release PRs unmergeable for a solo maintainer  |
| Require code owner review  | Off   | No `CODEOWNERS` file exists, and one naming the sole maintainer recreates the self-approval deadlock |
| Restrict deletions         | On    | Deleting `main` would orphan every published tag                                                     |
| Block force pushes         | On    | A force push can strand a published tag on an orphaned commit                                        |
| **Require linear history** | Off   | Release tags sit on PR merge commits; requiring linear history would break the release path          |
| Require signed commits     | Off   | Optional -- the release commit is API-created and signed, so enabling it would not break the flow    |

Tag rulesets are deliberately **not** configured: a `v*` rule can block
`github-actions[bot]` from pushing the release tag, which stops every publish
silently.

Note that `gh pr merge` may refuse a release PR with a stale `BLOCKED` merge
state while GitHub finishes recomputing rule evaluation. The REST endpoint is
authoritative: `gh api -X PUT repos/:owner/:repo/pulls/:n/merge -f merge_method=merge`.

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

## If no workflow run appears after the merge

Distinct from a publish that ran and failed. Here there is no run to read, so
there is nothing to diagnose yet.

**Wait and re-check before doing anything.** The v3.0.0 release looked like
dropped events and was actually late ones. Push runs for that merge commit do
exist, timestamped five and eight minutes after the merge, which is after the
manual repair had already published. That is what produced the duplicate
publish attempt:

```
16:51 workflow_dispatch  failure   <- repair attempt, no tag existed yet
16:56 workflow_dispatch  success   <- repair after pushing the tag by hand
16:59 push               failure   <- the merge event, arriving late: version already published
17:02 push               success   <- the tag event, also late
```

For comparison, the v4.0.0 merge created its run seven seconds after the merge
with byte-identical workflow config. Repository configuration was never the
problem; event delivery was slow during a GitHub incident window.

So give it several minutes and look again:

```bash
gh run list --workflow publish.yml --limit 5   # check twice, a few minutes apart
```

Only when a run genuinely never arrives, dispatch it:

```bash
gh workflow run publish.yml -f version=<version> --ref main
gh run watch
```

The dispatch creates the tag when it is missing, provided the dispatched ref's
packages already say that version. If they disagree it stops and says so, rather
than tagging a commit the version guard would reject. There is no need to push a
tag by hand for this case any more.

Confirm all four artefacts afterwards, since a dispatch that tags and publishes
still leaves `sync-dev` to run:

```bash
git ls-remote --tags origin | grep "v<version>"
npm view @wisecom/atlas-sdk@<version> version
gh release view "v<version>"
git log --oneline -1 origin/dev                     # should be at or ahead of main
```

If `sync-dev` was skipped or failed, fast-forward `dev` onto `main` by hand. A
`dev` that lacks the release commit means the next release branch is cut without
it.
