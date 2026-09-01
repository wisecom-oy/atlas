---
name: pr-review
description: >-
  Open a pull request for this repository and drive it to merge-ready,
  including triaging and answering the review comments CodeRabbit raises on it.
when_to_use: >-
  Use whenever the user asks to open, create, or submit a PR or pull request,
  and whenever CodeRabbit (or any reviewer) has raised comments on a PR that
  need to be addressed, answered, or resolved.
---

# Pull Requests and CodeRabbit Reviews

The rule: **a PR targets `dev`, carries a release-notes label, and is not done
until every review finding is either fixed or answered.** Never merge unless the
user asked you to.

## Opening the PR

1. Branch from `dev`, never from `main`. The only PRs targeting `main` are
   release and hotfix PRs, and those follow the `release` skill.
2. Run the quality gate before pushing: `pnpm run build`, `pnpm run lint`,
   `pnpm run format:check`, `pnpm run test`.
3. Open the PR against `dev` with a label:

```bash
gh pr create --base dev --label bug --title "<title>" --body-file <path>
```

| Label           | Use                                  |
| --------------- | ------------------------------------ |
| `enhancement`   | new behavior                         |
| `bug`           | fixes                                |
| `documentation` | docs-only changes                    |
| `security`      | security-relevant changes            |

Release notes are generated from these labels, so an unlabelled PR lands in the
wrong section. Mirror the sections of `.github/PULL_REQUEST_TEMPLATE.md`
(Summary, Changes, Checklist) in the body; `gh pr create` does not expand the
template. Use `--body-file`, not `--body`, so formatting survives. Link issues
with `Closes #123`.

The PR is a permanent public artifact: no secrets, no tenant data, no personal
or internal system detail. The substitution table in the `write-issue` skill
applies here unchanged.

## Handling CodeRabbit's review

`.coderabbit.yaml` auto-reviews every PR targeting `dev` and re-reviews on each
push. Release PRs (`chore(release):` titles) are skipped on purpose.

Wait for the walkthrough comment before triaging, then pull the inline findings:

```bash
gh api repos/{owner}/{repo}/pulls/<N>/comments \
  --jq '.[] | {id, path, line, body}'
```

Triage every finding into exactly one bucket:

- **Real** — correctness, missed callers, test gaps. Fix the root cause, not
  the symptom; check sibling callers before editing.
- **Wrong or nitpick** — verify the claim against the actual code first. If it
  does not hold, reply with the technical reason instead of changing anything.
- **Out of scope** — file it with the `write-issue` skill or add evidence to an
  existing issue. Do not silently widen the PR.

**REQUIRED SUB-SKILL:** Use `receiving-code-review` for the triage. CodeRabbit
is wrong often enough that blind agreement ships bugs; performative agreement
ships churn.

Apply accepted fixes as focused commits, run the targeted test plus
`pnpm run lint` and `pnpm run typecheck`, and push. CodeRabbit re-reviews each
push automatically.

## Answering and resolving threads

No thread stays dangling. Reply to each one: a fixed finding gets a short reply
naming the commit, a rejected finding gets the technical reason with file and
symbol references. Write replies per the `write-comment` skill (first person,
plain, no attribution).

Fetch unresolved threads and resolve them once handled:

```bash
gh api graphql -f query='
query($pr: Int!) {
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: $pr) {
      reviewThreads(first: 50) {
        nodes { id isResolved comments(first: 1) { nodes { body } } }
      }
    }
  }
}' -f pr=<N> --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)'

gh api graphql -f query='
mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id } }
}' -f id=<thread-id>
```

Reply to an inline comment in place rather than starting a loose PR comment:

```bash
gh api repos/{owner}/{repo}/pulls/<N>/comments/<comment-id>/replies -f body="<reply>"
```

## CodeRabbit commands

Post as a PR comment when needed:

| Command                  | Effect                                    |
| ------------------------ | ----------------------------------------- |
| `@coderabbitai review`   | incremental review of new commits         |
| `@coderabbitai full review` | re-review everything from scratch      |
| `@coderabbitai pause`    | stop automatic reviews on this PR         |
| `@coderabbitai resume`   | restart automatic reviews                 |

Normally none are needed: pushes trigger incremental reviews until the pause
limit. Use `full review` after a rebase or large restructuring, where
incremental context would be stale.

## Ready to merge

A PR is ready when CI is green, every thread is resolved or answered, and the
description still matches the final diff. Report that and stop. Merging is the
user's call; when asked to merge, use a merge commit (`gh pr merge --merge`),
which matches the repository history.
