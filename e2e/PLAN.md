# Atlas E2E Pipeline — Plan

Status: **phases 1–2 shipped** (#104, #106) and green against the live tenant — [run 32137149449](https://github.com/wisecom-oy/atlas/actions/runs/32137149449), 37 passed. Phases 3–4 remain (#107, #108). Every design question is answered in §4; §11 lists the tenant-side prerequisites, of which only the `ApplicationAccessPolicy` is still outstanding (#105). Amendments forced by reality are recorded in §12.

Closes the roadmap item at `docs/roadmap.md:98-100` ("CI/CD Restore & Backup Validation").

## 1. What this must prove

A weekly run answers one question: **does the shipped product still back up, verify, restore, export, replicate, recover and delete real Microsoft 365 data?**

The current CI (`.github/workflows/ci.yml`) runs unit tests only — 502 tests that all mock Graph and S3. Nothing in the repo exercises a real Graph call. Every bug fixed in issues #90, #93, #94 was found by a human running the CLI by hand; that is the gap this closes.

Non-goals: performance benchmarking (`tools/perf` owns that), unit-level coverage, and per-PR runs (see §7).

## 2. Language: Python + pytest

**Decision: Python 3.12 + pytest, dependencies pinned with `uv`.** Not JavaScript, not Bash.

Why not Bash: the suite must (a) get an OAuth2 client-credentials token, (b) make paged Graph calls, (c) compare restored content byte-for-byte against seeded content, (d) list S3 keys and read Object Lock retention, (e) clean up by tag. In Bash that is hand-rolled `curl`/`jq`/`aws` plumbing with no assertion vocabulary and no test isolation.

Why pytest specifically — it already gives us, for free, everything a hand-rolled harness would have to grow:

| Need                                         | pytest feature                                                 |
| -------------------------------------------- | -------------------------------------------------------------- |
| Modularity, "easy to add a case later"       | one function per case, no registration boilerplate             |
| Setup/teardown that runs even on failure     | fixtures with `yield` + `addfinalizer`                         |
| Shared seeded data across a workload's cases | `scope="module"` / `scope="session"` fixtures                  |
| Run one suite locally                        | `pytest -k outlook`                                            |
| CI reporting                                 | `--junitxml`, `-o junit_family=legacy`                         |
| Ordered dependency (backup before restore)   | `pytest-dependency`, or simply one test function per lifecycle |

Dependencies (4, all boring): `httpx` (Graph HTTP), `msal` (token acquisition — Microsoft's own library, handles the client-credentials flow and caching), `boto3` (S3/MinIO assertions incl. Object Lock), `pytest`.

The Atlas CLI is driven as a subprocess (`node packages/cli/dist/cli.mjs …`). That is deliberate: the pipeline tests **the artifact we ship**, including argument parsing, config resolution and exit codes. The SDK surface (`packages/sdk`) is exercised in one dedicated case (§5.7) so both public entry points are covered.

## 3. Layout

```
e2e/
  PLAN.md                     # this file
  README.md                   # how to run locally, what the secrets are, how to add a case
  pyproject.toml              # deps + pytest config (uv-managed)
  docker-compose.e2e.yml      # primary + replica MinIO, lock-capable
  conftest.py                 # fixtures only, no test logic
  atlas_e2e/
    config.py                 # env → typed settings, fails fast with a named missing var
    atlas.py                  # CLI runner: atlas("outlook", "backup", "-m", box) -> Result(code, stdout, stderr)
    graph.py                  # Graph client: token, get/post/put/delete, paging, 429 handling
    seed.py                   # create test data via Graph (mail / OneDrive file / SharePoint file)
    probe.py                  # read back via Graph: find message by subject, file by path, hash content
    storage.py                # boto3 helpers: list keys under prefix, get retention, bucket lock status
    marker.py                 # run-id tagging + "is this mine?" predicate + stale-run sweep
    cleanup.py                # delete everything carrying a marker, Graph side and S3 side
  tests/
    test_00_preflight.py
    test_10_outlook.py
    test_20_onedrive.py
    test_30_sharepoint.py
    test_40_replication.py
    test_50_immutability.py
    test_60_regressions.py
```

Adding a case later = one function in the matching `tests/` file, using existing fixtures. Adding a workload = one file plus seed/probe functions. No framework to learn.

## 4. Decisions (answered 2026-08-18)

| Question         | Decision                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Test identity    | **Test folder inside the existing Wisecom mailbox / OneDrive**, no dedicated license. See §4.0 for why this is containable.   |
| App registration | **New Entra app**, Exchange `ApplicationAccessPolicy` scoped to that one mailbox.                                             |
| MinIO cleanup    | **Purge the tenant bucket at the end of every run** (`atlas outlook delete --purge -y`), which also exercises the purge path. |
| Immutability     | **Governance weekly, compliance monthly.**                                                                                    |
| Failure signal   | **Red run only** — no auto-issue, no webhook.                                                                                 |
| Storage backends | **MinIO only.**                                                                                                               |

### 4.0 Why a folder in a live mailbox is safe — and where the limits are

The suite writes into a real mailbox and a real OneDrive, so containment is a property of the product, not of good intentions. Verified in code:

- **Outlook restore cannot touch existing mail.** Every restore creates a fresh `Restore-{timestamp}` root folder and rebuilds the folder tree inside it (`packages/outlook/src/services/restore/folder-restore-planner.ts:28-37`, called from `restore.service.ts:241` and `restore-execution-orchestrator.ts:130`). It never writes into Inbox or any pre-existing folder.
- **Backup scope is explicit.** Seeding happens in `atlas-e2e-<run_id>` and backup always passes `-m <mailbox> -f atlas-e2e-<run_id>`, so only that folder is read. A bare `atlas outlook backup` would enumerate every mailbox in the tenant; the runner never issues one.
- **OneDrive/SharePoint restore writes to the original `parent_path`** — there is no `Restore-` root on the file workloads (`packages/onedrive/src/services/onedrive-restore.service.ts:151-165`). Containment therefore comes from seeding: fixtures live only under `/atlas-e2e-<run_id>/`, so a restore can only recreate paths inside that folder.
- **Nothing is overwritten.** File restores always pass `--conflict rename` (`graph-onedrive-restore.adapter.ts:136,165` default `rename`).

Residual risk, stated plainly: the GitHub-stored secret can read and write the whole of that one mailbox and its OneDrive, because Graph application permissions are per-user at best. The `ApplicationAccessPolicy` bounds it to a single identity; it cannot bound it to a single folder. If that is not acceptable, the answer is a dedicated test user (question 1, option A), not extra code here.

### 4.1 Purge vs. compliance-mode retention

These two decisions collide once a month and the suite must not paper over it. Atlas derives the bucket from the tenant id (`atlas-<tenant_id>`), and Graph needs the _real_ tenant id, so the compliance leg cannot be isolated into its own bucket. Compliance-mode objects are undeletable until expiry, so the monthly run's closing purge will legitimately report `retained_objects > 0`.

Handling: the purge assertion is parameterised. Weekly (governance) asserts `retained == 0 and failed == 0`. Monthly (compliance) asserts `failed == 0` and that every retained key is one the compliance case itself locked, with `--retention-days 1`; the next weekly run purges them after expiry. No unexplained survivors are ever tolerated.

## 5. The two invariants that make this safe to run weekly

### 5.1 Everything is tagged

Every artifact the run creates — mail subject, folder name, file name, zip export, restore target folder — embeds a marker:

```
atlas-e2e-<run_id>          run_id = GH run id, or "local-<epoch>" outside CI
```

Cleanup deletes **only** objects whose name matches `atlas-e2e-*`. It never deletes by "everything in this mailbox". A bug in the suite therefore cannot destroy real data in the Wisecom tenant.

Teardown also sweeps markers older than 24 h, so a run that dies mid-flight (runner killed, Graph outage) does not leak fixtures forever.

### 5.2 Restore is verified against Graph, never against Atlas output

This is the core of the design and the reason Graph scripting is in scope:

```
seed:    Graph POST  → message with subject "atlas-e2e-<run>-mail-1", known body
backup:  atlas outlook backup -m <box>
assert:  S3 keys exist under data/<owner>/ and manifests/<owner>/   (boto3)
verify:  atlas outlook verify -s <snap> -m <box>                     (exit 0)
delete:  Graph DELETE → remove the seeded message from the mailbox
restore: atlas outlook restore -s <snap> -m <box>
assert:  Graph GET → the message is back, and its body/attachment hash equals what we seeded
```

Atlas claiming "restored 1 item" proves nothing; Graph returning the message with a matching content hash proves it. The same shape applies to OneDrive and SharePoint (seed file → back up → delete from the drive → restore → re-download via Graph → compare SHA-256).

Assertion sources, in order of preference: **Graph state** > **S3 object keys/retention** (boto3) > **process exit code** > **`stats --json`**. Ink-rendered tables are never parsed — issue #94 documents that they wrap and fragment, and `outlook read --raw` currently prints a banner before its JSON, so it is not pipeable. The suite does not depend on either.

## 6. Suites

| #   | File                      | Covers                                                                                                                                               | Key assertions                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | `test_00_preflight.py`    | `atlas config validate`, `atlas storage-check`, Graph token, required app permissions                                                                | exit 0; storage-check reports `lock-capable`; a named failure per missing permission so a broken app registration is diagnosed in seconds, not by a cascade of red tests                                                                                                                                       |
| 6.2 | `test_10_outlook.py`      | seed → backup (initial) → `list` → `verify` → `save` → delete-from-mailbox → `restore` → Graph compare → incremental backup → `status` → `delete -y` | full lifecycle per §5.2; **incremental**: seed a 2nd message, re-run backup, assert mode is incremental and only the new object was added (delta cursor honoured, `manifest.delta_links` advanced)                                                                                                             |
| 6.3 | `test_20_onedrive.py`     | backup → `list-snapshots` → `list-versions` → `verify` → `save` → delete file → `restore --conflict rename` → Graph SHA-256 compare                  | file versions: seed file, upload a 2nd version, assert both versions are in the index (`onedrive/index/<owner>/files/<id>.json`)                                                                                                                                                                               |
| 6.4 | `test_30_sharepoint.py`   | `list-sites` → resolve by URL → backup → `verify` → `save` → delete → `restore` → Graph compare                                                      | `--site` accepts URL, `hostname:/sites/x`, and composite id identically (regression guard for #90)                                                                                                                                                                                                             |
| 6.5 | `test_40_replication.py`  | `replicate` to the replica MinIO → `replicate --status` → purge primary → `rehydrate` → `verify` on primary                                          | DR loop is the whole point: after rehydrate, primary must verify clean; DEK is copied first and never regenerated                                                                                                                                                                                              |
| 6.6 | `test_50_immutability.py` | backup with `--retention-days 1 --lock-mode governance` (weekly) / `compliance` (monthly) `--require-immutability` → attempt `delete`                | delete reports `retained_*` (not `failed_*`); retention timestamp present on the S3 object; `storage-check` classifies the bucket green; purge assertion per §4.1                                                                                                                                              |
| 6.7 | `test_60_regressions.py`  | one case per shipped bug so it cannot come back                                                                                                      | #93: read-only commands against an unknown tenant id create **no** bucket (`ListBuckets` identical before/after) and report "No backups found"; #76: a storage auth error is not reported as AES-GCM tampering; SDK smoke: `createAtlasInstance` → `outlook.listSnapshots()` returns the snapshot the CLI made |

Every seeded fixture is a few kilobytes. A full run should be single-digit minutes and cost nothing.

## 7. Infrastructure in the runner

```yaml
# e2e/docker-compose.e2e.yml (sketch)
services:
  minio-primary:
    image: minio/minio:latest
    command: server /data{1...4} --console-address ":9001"
    ports: ['9000:9000']
  minio-replica:
    image: minio/minio:latest
    command: server /data{1...4}
    ports: ['9002:9000']
```

Two notes, both load-bearing:

- **Four drives, not one.** Object Lock requires bucket versioning, and versioning has historically required MinIO's erasure-coded backend; single-drive support depends on the MinIO version. Four drives in one container is the configuration that works on every version, so the immutability suite (§6.6) is not at the mercy of an image bump. `test_00_preflight` asserts `storage-check` says `lock-capable` and fails the run early if the backend regressed.
- **Two endpoints, not two buckets.** Atlas derives the bucket name from the tenant id (`atlas-<tenant_id>`), so a replication target must be a _different endpoint_ — hence the second MinIO on 9002.

Started with `docker compose -f e2e/docker-compose.e2e.yml up -d --wait` (a GitHub Actions `services:` block cannot pass the `server /data{1...4}` command). The existing `docker/docker-compose.yml` stays as-is for local development.

## 8. Workflow

```yaml
# .github/workflows/e2e.yml (sketch)
on:
  schedule:
    - cron: '0 3 * * 1' # weekly, governance leg
    - cron: '0 4 1 * *' # monthly, compliance leg
  workflow_dispatch:
    inputs:
      suite: { description: 'pytest -k expression', default: '' }
permissions: { contents: read }
concurrency: { group: atlas-e2e, cancel-in-progress: false }
```

- **Never on `pull_request`.** Fork PRs get no secrets, and a PR-triggered job that _does_ hold tenant credentials is a code-execution-to-secret-exfiltration path. Scheduled + manual only.
- **`concurrency`** serialises runs: two suites seeding the same mailbox concurrently would fight over delta cursors.
- **`timeout-minutes: 30`**, no automatic retry — a retry that turns red into green hides exactly the flakiness we want to see.
- Steps: checkout → pnpm install → `pnpm run build` → compose up → `uv run pytest --junitxml` → cleanup (always) → compose down → summary.
- Cleanup runs in an `if: always()` step **and** in pytest teardown, so a crashed interpreter still gets swept by the following step.

## 9. Secret handling (public repository)

| Rule                                         | Mechanism                                                                                                                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets only reach the E2E job               | repository **environment** `e2e` with required reviewers; org/repo secrets are not exposed to any other workflow                                                                                      |
| No secret in the log, ever                   | secrets referenced only as `env:` on the pytest step; `set -x` never enabled; GitHub auto-masks registered secret values                                                                              |
| No secret in derived output                  | anything we compute from a secret (bucket names carry the tenant id) is registered with `echo "::add-mask::$value"` before first use                                                                  |
| Test artifacts are safe to publish           | JUnit XML contains test names only. CLI logs are scrubbed before upload; `tools/graph-tap/tap.mjs` already elides tokens and templates GUIDs/UPNs and is reused as the scrubber's reference behaviour |
| The tenant is never identifiable in the repo | tenant id, site URL, mailbox and owner ids are **all** secrets — the plan and code contain only placeholder names like `E2E_MAILBOX`                                                                  |
| Failure output cannot leak                   | assertion messages print marker names and counts, never message bodies, never file contents, never tokens                                                                                             |

Secrets required (names only): `E2E_TENANT_ID`, `E2E_CLIENT_ID`, `E2E_CLIENT_SECRET`, `E2E_ENCRYPTION_PASSPHRASE`, `E2E_MAILBOX`, `E2E_ONEDRIVE_OWNER`, `E2E_SHAREPOINT_SITE`. MinIO credentials are generated per run and are not secrets.

## 10. Phasing

Each phase ends with something that runs green in CI; no phase leaves a stub behind.

| Phase | Deliverable                                                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **Shipped (#104).** `e2e/` skeleton, fixtures, marker + cleanup, preflight suite, full Outlook lifecycle (§6.1–6.2), compose file, workflow.                    |
| 2     | **Shipped (#106).** OneDrive + SharePoint suites (§6.3–6.4).                                                                                                    |
| 3     | Replication/rehydrate + immutability (§6.5–6.6), monthly compliance cron.                                                                                       |
| 4     | Regression suite (§6.7), weekly cron enabled, `$GITHUB_STEP_SUMMARY` reporting, `e2e/README.md`, roadmap item at `docs/roadmap.md:98-100` rewritten as shipped. |

## 11. Prerequisites on you (not codeable here)

Phase 1 cannot run green until these exist. Everything else is implementation work.

1. **New Entra app registration** with application permissions `Mail.Read`, `Mail.ReadWrite`, `MailboxSettings.Read`, `User.Read.All`, `Files.ReadWrite.All`, `Sites.Read.All` (+ `Sites.Manage.All` for SharePoint restore), admin-consented. The first live run proved the shorter list insufficient: listing `mailFolders` succeeds with `Mail.ReadWrite` alone, while backup also reads `mailboxSettings` and enumerates `/users`, so preflight probes each permission against the endpoint the product actually calls.
2. **Exchange `ApplicationAccessPolicy`** restricting that app to the one test mailbox:
   `New-ApplicationAccessPolicy -AppId <id> -PolicyScopeGroupId <mailbox> -AccessRight RestrictAccess`.
3. **SharePoint test site** created, and its URL recorded as a secret.
4. **GitHub environment `e2e`** holding: `E2E_TENANT_ID`, `E2E_CLIENT_ID`, `E2E_CLIENT_SECRET`, `E2E_ENCRYPTION_PASSPHRASE`, `E2E_MAILBOX`, `E2E_ONEDRIVE_OWNER`, `E2E_SHAREPOINT_SITE`.

Note that the tenant id used by the suite is your real tenant, so the E2E MinIO bucket is `atlas-<tenant_id>` — the same name a production run against that tenant would use. It only ever exists inside the runner's throwaway MinIO, never on a real endpoint.

## 12. Amendments from the first live runs

What the plan got wrong, and what the code does instead. Kept here because each one is a property of the product, not of the harness.

| Assumption                                                  | Reality                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preflight can assert `storage-check` reports `lock-capable` | It reports `not-ready` until a bucket exists, and no read-only command provisions one since #93. Preflight creates the tenant bucket with `ObjectLockEnabledForBucket`, exactly as `s3-bucket-manager.ts` does on first backup. |
| The trigger is scheduled-only                               | Also `push` on `main` and `dev`, at the maintainer's request. Still never `pull_request`. The E2E badge in `README.md` reports status, and the job is deliberately not a required check — `ci.yml` stays the merge gate.        |
| Secrets come from a GitHub environment                      | They are repository secrets; `environment:` is not attached, because approval rules would stall unattended runs.                                                                                                                |
| Compose can start MinIO with `server /data{1...4}`          | The four drives must exist, so they live under one mounted volume (`/data/{1...4}`). Volumes are also destroyed after every run, and the teardown fails if any survives.                                                        |
| Backup scope can be trusted to a `--folder` selector        | `outlook backup -f` matches a bare folder name **at any depth**, so a restored copy re-enters scope. Incremental deltas are therefore measured before any restore.                                                              |
| The file workloads can be scoped like Outlook               | `onedrive backup` and `sharepoint backup` have no folder filter at all; they sync the whole drive or site. Version assertions are deltas across a second backup rather than absolute object counts.                             |
| The purge assertion belongs to the Outlook suite            | `--purge` sweeps the whole bucket, so it lives in `test_90_purge.py` and runs after every workload.                                                                                                                             |

### Product defects the pipeline found on its first passes

- **#110** — SharePoint backup exited 2 `UNHEALTHY` for every new file: the current version was fetched through the version-content endpoint, which Graph refuses, because the guard compared SharePoint's `'1.0'`-style id against the literal `'1'`. Fixed in #111.

This is the return the pipeline was built for: a defect that unit tests could not see, on the first run that touched a real SharePoint site.
