---
name: triage-finding
description: >-
  Decide what to do with a problem discovered while working on something else.
  Verifies the finding, checks it is not already tracked, weighs it against the
  Atlas failure modes that matter, and reaches one of five outcomes: fix it here,
  file it, add evidence to an existing issue, or drop it.
when_to_use: >-
  Use whenever work on one task turns up a problem that is not part of that task:
  during implementation, debugging, code review, test writing, coverage work, a
  red E2E run, or reading unfamiliar code. Also use when the user says "triage
  this", "should this be an issue", "is this worth filing", "note this for
  later", or asks what to do with something you found in passing.
---

# Triaging a Finding

The rule: **the current task stays the priority, and the tracker stays a list of
real engineering work.** A finding earns an issue by being verified, reachable,
independent, and consequential. Not by looking wrong.

This skill decides _whether_ and _what_. Once the answer is "file it", hand the
writing to `skill://write-issue`, which owns issue structure, acceptance
criteria, and the tenant-data scrub. Do not restate any of that here.

## The five outcomes

Every significant finding ends at exactly one:

| Outcome        | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `CURRENT TASK` | In scope, cheap, and the fix belongs in the branch you already have open |
| `RECORD`       | Real, independent, consequential. File it via `skill://write-issue`      |
| `DUPLICATE`    | Already tracked. Add the new evidence as a comment instead               |
| `INVESTIGATE`  | Cannot classify yet, and the check is cheap enough to run now            |
| `IGNORE`       | Verified as not worth tracking. Say why in one line and move on          |

State the outcome explicitly when you report back. An unlabelled observation
buried in a summary is how findings get lost.

`IGNORE` is a legitimate, common answer. So is `CURRENT TASK`: a one line guard
in the function you are already editing does not need a ticket.

## Verify before you classify

Never classify on suspicion. Read the surrounding execution path and establish:

- **What the code is meant to do.** Comments in this repo carry design decisions,
  not narration. `// Against the snapshot that recorded the entry, not the one
being verified` is an invariant. Contradicting it is a finding; misreading it
  is not.
- **Whether a `ponytail:` comment already owns it.** Those mark deliberate
  shortcuts and name their ceiling and upgrade path (`packages/s3/src/adapters/s3-bucket-manager.ts:75`,
  `packages/types/src/ports/mail/connector.port.ts:100`). A shortcut behaving as
  documented is not a defect. `ponytail-debt` already harvests these, so filing
  one as a bug double-tracks it. Recording it is justified only when you can show
  the named ceiling has actually been crossed.
- **Whether the path is reachable.** Hexagonal layering makes this concrete:
  a port method with no adapter calling it, or an adapter branch no service
  reaches, is dead surface. Prove reachability with `lsp references` before
  claiming a live defect. #179 removed an entire flag that read as functional and
  was inert.
- **Whether it is `dist/`.** `packages/*/dist/` is build output. A finding there
  belongs to the `src/` file that produced it, if anywhere.
- **Whether tests already pin it.** A passing test asserting the behaviour you
  think is wrong reframes the finding: either the test encodes a decision you
  have not found the reason for, or the test is the bug. Both are worth saying
  out loud; they are different issues.
- **Whether the twin agrees.** See below. This is the most productive check in
  this codebase.

Do not modify unrelated code to prove a finding. A failing unit test written
against current behaviour, or a `grep`/`lsp` trail, is enough evidence.

## Check the twin first

Atlas carries deliberate near-duplicates: OneDrive and SharePoint drive
pipelines, and to a lesser extent Outlook against both. When something looks
wrong in one, **read the other before deciding anything.** The three answers:

1. **Both do it.** Shared intent, or a shared defect. Either way one issue, both
   packages named in it.
2. **Only one does it, and the other is correct.** The strongest kind of finding
   in this repo. It has a reference implementation, so it is cheap to fix and
   cheap to review.
3. **They diverge and neither is obviously right.** Record the divergence itself,
   with both behaviours stated. Verified examples: SharePoint's private
   `download_from_url` retries `429` with `Retry-After` while OneDrive imports a
   different implementation entirely (#247); `sharepoint-large-file-chunk-download.ts`
   had no tests while its OneDrive twin had them since #36 (#192).

A divergence that reaches an operator as inconsistent behaviour across two
workloads is worth an issue even when neither side is a bug in isolation.

## What matters in Atlas

Weigh consequence against this product, not against software in general. Atlas is
a backup tool, so the ranking is not the usual one.

**Record readily.** These are the failure classes this repo keeps finding:

- **A backup that reports success while losing data.** The worst class Atlas has.
  #173 and #31 both surfaced as "verify says healthy". #190 wrote a manifest after
  blob copies failed.
- **Anything unrestorable.** Data that went in and cannot come back out: #144
  (streaming decrypt aborting above 4 MB), #168 (snapshots unresolvable in
  replicate and rehydrate).
- **Silent skips and swallowed errors.** A file omitted from a manifest with only
  a log line, an exit code that says complete when a bucket was non-empty. Exit
  codes are a contract: `0` complete, `1` hard failure, `2` partial. A path that
  returns the wrong one is a defect even when nothing crashed.
- **Misclassified errors.** One status meaning two things, or classification by
  substring. #76 read a storage auth error as AES-GCM tampering; #246 reads every
  `403` as an expired URL. Both cause a real fault to be reported as the wrong
  fault, which is worse than an unhandled one.
- **Encryption, DEK handling, and key material lifetime.** A tenant context not
  destroyed on an error path, a key held past its use, a replica missing
  `_meta/dek.enc` and therefore unopenable. Label `security`.
- **Object Lock and retention.** A retained object copied without its policy, a
  mode requested and not honoured. Silent loss of immutability defeats the
  feature's entire purpose.
- **Graph cost and throttling.** Per-item calls where a batch or `$select` exists,
  a retry storm against a shared `429` pool, a delta cursor reset forcing full
  re-enumeration. Ground the claim in `docs/operations/graph-rate-limits.md` and
  the resource unit costs, not in intuition. #161 was 60k round trips and a 64 KB
  minimum-billable-object waste per backup.
- **Tenant data reaching somewhere it should not.** Logs, reports, E2E artifacts
  (#174, #175). Always `security`.
- **Untested behaviour that has already broken once.** Coverage gaps are worth
  filing when the code is load bearing and the failure mode is demonstrated, not
  as a general percentage complaint. #192 through #195 are the shape to follow:
  name the files, the measured numbers, and what the tests must pin.

**Do not record.** Verified and dropped is the right outcome for:

- Naming, formatting, or structure with no consequence named. `code smell` exists
  for real maintainability problems, not for preference.
- A theoretical edge case with no reachable path.
- Speculative optimisation with no measurement. `skill://atlas-perf` exists;
  measure first, then decide.
- Duplication that is deliberate. See the twin section. Two near-identical drive
  pipelines are a known, accepted shape.
- Anything you can correct in the current branch in a few lines without pulling
  in another subsystem. That is `CURRENT TASK`.
- "This file is over 300 lines" on a file you are not touching. The rule is
  enforced by lint on change.

## Scope: is it this branch's problem?

Handle it in the current task when it is a direct consequence of your change, or
a small fix in a file you have already opened, in the same subsystem, with no new
test surface.

Split it out when any of these hold:

- It lives in another package.
- It expands the diff enough to change what reviewers are reviewing.
- The right fix is unclear, or there are two defensible answers.
- It needs its own tests, or its own docs section.
- It changes user-visible behaviour and your current PR does not.
- It is a production fix and your current PR is test-only. Keep coverage PRs
  behaviour-neutral: pin current behaviour, file the defect, let the fix land
  against tests that fail when it is wrong. #247 and #246 were split exactly this
  way, and the coverage issue says so in writing.

One PR closes one issue. `Fixes #N` in the commit and PR body.

## Do not duplicate

Search before drafting, and **search closed issues too**:

```bash
gh issue list --search "<keywords>" --state all --limit 10
gh issue list --label test --state all --limit 30
gh issue list --milestone <current> --state all
```

Try the failure mode, the symptom, and the symbol name separately. Findings in
this repo are frequently near-misses of closed work: #53 named the exact lines
#246 is about, but its fix landed upstream of them and left the classification
untouched. That is a `RECORD` with a reference to #53, not a duplicate.

Reasons a match is not a duplicate: it is closed and the fix addressed a
different layer; it is an `epic` that needs breaking down anyway; it lists your
file in a table but not in its acceptance criteria, so closing it would not cover
you. Say which applies.

When it _is_ a duplicate, comment the new evidence on the existing issue and
cross-reference in both directions. `skill://write-comment` covers the comment.

Do not split one root cause into several issues because the symptoms differ. Do
split one issue when it contains two decisions, as with a behaviour fix and the
coverage that must precede it.

## E2E failures are not automatically product bugs

A red `e2e.yml` run has three possible causes, and they are labelled differently:

1. **A product regression.** Normal bug.
2. **A harness defect.** The suite is stateful and ordered, so a test can inherit
   state an earlier test destroyed. Label `e2e`. The `test_85_workload_delete`
   failure on the v3.0.0 release candidate was this: it asserted drive manifests
   survived a purge, but `test_40` had already purged the primary bucket and
   `replicate` is scoped per mailbox, site, or owner with no `--all`, so no drive
   manifest was ever recovered. A product regression was the wrong reading, and
   the release was correct to proceed.
3. **Live tenant or Graph flake.** Throttling, quota, transient auth. `upstream`
   if it is genuinely Microsoft side. Not an issue if it is weather.

`e2e/` is not published. A defect there costs nothing to a user and everything to
your ability to trust a green run, so it is still worth filing.

## Confidence and severity

Classify internally, then map to labels.

| Confidence | Meaning                                        | Action                                                    |
| ---------- | ---------------------------------------------- | --------------------------------------------------------- |
| High       | Demonstrated by code, a failing test, or a run | `RECORD` when impact is real                              |
| Medium     | Strong evidence, root cause not pinned         | `RECORD` only if the impact class above justifies digging |
| Low        | Mostly inference                               | `INVESTIGATE` if cheap, otherwise `IGNORE`                |

Never write a root cause you have not verified. Separate the three explicitly in
the issue: what you observed, what you verified, what you suspect. A wrong root
cause in a permanent issue costs the next reader more than no root cause.

Severity is consequence, never difficulty:

| Label              | Use                                                                              |
| ------------------ | -------------------------------------------------------------------------------- |
| `priority: high`   | Data loss, unrestorable backup, security exposure, success reported over failure |
| `priority: medium` | A real defect with a workaround, or one that blocks planned work                 |
| `priority: low`    | Legitimate but deferrable                                                        |
| none               | You are guessing. Leave it off                                                   |

Add `security` for anything touching credentials, key material, encryption,
retention, or tenant data exposure. Add `test` for coverage. Add `code smell` for
maintainability with a named consequence. Add `epic` when it needs breaking down
rather than doing. Add `upstream` when the cause is outside the repo.

Do not set a milestone on an incidental finding. Milestones are release planning;
attaching a drive-by finding silently expands the release.

## Preserve how you found it

One line, at the end of the issue, when it helps:

> Found while writing coverage for `onedrive-verification.service.ts` (#193).
> Independent of that work: the behaviour predates it.

This tells the next reader the finding is incidental rather than caused by recent
work, and points at the context that produced the evidence. Do not narrate the
session beyond that.

## Then go back to work

Investigate enough to classify, record the evidence, file or comment, return to
the original task. Incidental discovery is not a licence to refactor. If a
finding turns out to be large, that is exactly why it is an issue and not a
detour.

Before you resume, confirm your branch is clean of triage side effects: mutation
experiments reverted, scratch files removed, no unrelated edits staged. Anything
you touched to prove a point must be undone, and the proof lives in the issue.

## Reporting back

Keep it short and lead with the outcome:

```
RECORD  (high confidence, priority: medium, bug + security)
  Every 403 on the drive download path is read as an expired URL, so a missing
  Files.Read.All becomes a per-file retry storm reported as a skipped file.
  is_expired_url_error:113 and rethrow_if_access_denied:123, twelve lines apart,
  read the same status oppositely. Same class as #76. Not covered by #53, whose
  fix landed upstream of these lines.
  -> filed as #246, cross-linked to #247
```

Then continue. Do not ask which outcome to take when the evidence settles it.
File only with the user's approval, which `skill://write-issue` requires.

## House style

Prose in this repo takes no em dash and no `--` as punctuation. Rewrite the
sentence instead. This applies to issue bodies and comments, not to CLI flags or
code.
