# Atlas E2E suite

End-to-end tests that drive the **shipped CLI bundle** (`packages/cli/dist/cli.mjs`) against a real
Microsoft 365 tenant, with MinIO providing S3 storage inside the runner. Unit tests mock Graph and
S3; nothing else in this repository makes a real Graph call, so this is the only place a broken
restore path can be caught before a customer finds it.

Design and rationale: [`PLAN.md`](./PLAN.md). Tracking: issue #103.

## What a run does

1. Seeds a mail folder named `atlas-e2e-<run_id>` in the test mailbox, with a message and a random
   4 KB attachment (Graph).
2. Backs up **only that folder** (`-m <mailbox> -f atlas-e2e-<run_id>`), then asserts real objects
   exist under `manifests/`, `data/` and `attachments/` (boto3).
3. Verifies, exports to `.eml`, then **deletes the message from M365** and restores it.
4. Re-reads the restored message through Graph and compares the attachment SHA-256 with the bytes
   it seeded. The tool's own "restored 1 item" output is never treated as evidence.
5. Seeds a second message, re-runs the backup, and asserts the run resumed from saved delta state
   and stored exactly one new blob.
6. Purges the tenant bucket and sweeps every marked artifact from the mailbox.

## Running locally

```bash
pnpm run build                                             # the suite runs dist/cli.mjs, not src
docker compose -f e2e/docker-compose.e2e.yml up -d --wait  # MinIO on 9000 (+ replica on 9002)

cd e2e
export E2E_TENANT_ID=...            # Entra tenant GUID
export E2E_CLIENT_ID=...            # the E2E app registration
export E2E_CLIENT_SECRET=...
export E2E_ENCRYPTION_PASSPHRASE=...  # not your production passphrase
export E2E_MAILBOX=you@example.com  # mailbox the app is scoped to

uv run pytest                       # everything
uv run pytest -k preflight          # just the environment checks
uv run pytest -k outlook            # just the Outlook lifecycle
```

Optional, used by the phase-2 suites: `E2E_ONEDRIVE_OWNER`, `E2E_SHAREPOINT_SITE`. Their preflight
checks skip when unset.

MinIO defaults (`E2E_S3_ENDPOINT`, `E2E_S3_ACCESS_KEY`, `E2E_S3_SECRET_KEY`,
`E2E_S3_REPLICA_ENDPOINT`) need no configuration for a standard local run.

## Required app permissions

Application permissions (not delegated), admin-consented. Preflight probes each one and names the
missing grant, so a permission gap fails in seconds instead of mid-backup:

| Permission             | Needed for                                                  |
| ---------------------- | ----------------------------------------------------------- |
| `Mail.Read`            | backup, list, save, verify                                  |
| `Mail.ReadWrite`       | seeding fixtures and restoring                              |
| `MailboxSettings.Read` | folder enumeration and `userPurpose` (shared-mailbox) reads |
| `User.Read.All`        | mailbox/owner discovery, email-to-object-id resolution      |
| `Files.ReadWrite.All`  | OneDrive suite (backup and restore)                         |
| `Sites.Read.All`       | SharePoint suite (site resolution and backup)               |
| `Sites.Manage.All`     | SharePoint restore                                          |

The canonical product-wide list lives in [`docs/azure-ad-setup.md`](../docs/azure-ad-setup.md).

## Safety model

The suite writes into a **real** mailbox, so containment is enforced, not assumed:

| Rule                                                                     | Why it holds                                                                                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup always passes `-m` and `-f <marker>`                              | A bare `atlas outlook backup` enumerates every mailbox in the tenant.                                                                         |
| Cleanup deletes only names starting `atlas-e2e`                          | A bug in the suite cannot reach real mail.                                                                                                    |
| Foreign markers are only swept once stale (24 h)                         | A local run cannot delete a scheduled run's live fixtures.                                                                                    |
| `Restore-*` roots are deleted only when they contain a marked descendant | Atlas names restore roots without our marker; an operator's own restore is never touched.                                                     |
| `E2E_S3_ENDPOINT` must be runner-local                                   | The bucket name embeds the real tenant id, so a shared endpoint would mean writing test data into a production bucket. Asserted in preflight. |
| Outlook restore cannot overwrite existing mail                           | The product always builds a fresh `Restore-{timestamp}` root (`folder-restore-planner.ts:28-37`).                                             |

Residual risk: the stored client secret can read and write the whole of that one mailbox, because
Graph application permissions cannot be scoped below a user. An Exchange `ApplicationAccessPolicy`
bounds it to a single identity — see issue #105.

## Adding a case

- **New assertion on an existing workload**: one function in the matching `tests/test_*.py`, using
  the existing fixtures (`cli`, `graph`, `s3`, `settings`, `run_marker`, `exports`).
- **New workload**: one `tests/test_*.py`, plus seed/probe functions in `atlas_e2e/`.
- Assertion sources, in order of preference: **Graph state** > **S3 keys and retention** > **process
  exit code** > **`stats --json`**. Never parse Ink tables — they wrap and fragment (issue #94).
- Anything created must carry `run_marker` in its name, or cleanup will not find it.

## CI

`.github/workflows/e2e.yml` runs on pushes to `main` and `dev`, and on manual dispatch. The weekly
and monthly crons land with issue #108.

It never runs on `pull_request` — the job holds tenant credentials, and a PR trigger would let
fork-supplied code exfiltrate them. Secrets are repository secrets (`E2E_*`); no GitHub environment
is attached, because approval rules would leave unattended runs waiting for a human.

**The workflow gates nothing.** A live-tenant run depends on Graph and network availability, so it
is deliberately not a required status check: `ci.yml` remains the merge gate, while E2E reports
status through its own badge and a per-test table on the run's summary page
(`python -m atlas_e2e.summary`). A red E2E means "investigate", not "blocked".
