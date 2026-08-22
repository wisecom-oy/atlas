# Atlas E2E suite

End-to-end tests that drive the **shipped CLI bundle** (`packages/cli/dist/cli.mjs`) against a real
Microsoft 365 tenant, with MinIO providing S3 storage in the runner. Unit tests mock Graph and S3;
this is the only place a real Graph call happens, so it is where a broken restore path gets caught
before a customer finds it. Runs nightly in CI (`.github/workflows/e2e.yml`).

## What a run does

Each suite is a lifecycle — every step depends on the previous one:

- **Outlook** (`test_10`): seed a marked folder → back it up → verify → export → delete the message
  from M365 → restore → compare the restored attachment against the seeded bytes **through Graph** →
  incremental backup delta.
- **OneDrive / SharePoint** (`test_20`, `test_30`): same shape per drive/site, including a second
  file version, a conflict-rename restore, and a 5 MB file that forces chunked download and
  streaming restore instead of the small-file path.
- **Regression guards** (`test_35`): one case per shipped bug that only reproduces against real
  infrastructure.
- **Disaster recovery** (`test_40`): replicate to the replica MinIO → purge primary → rehydrate →
  verify the recovered data decrypts.
- **Purge** (`test_90`): `delete --purge` must leave an empty bucket.
- **Immutability** (`test_95`): backup with Object Lock → S3 reports the retention → deleting the
  locked object fails. Runs last on purpose: a locked object would make the purge assertion
  unsatisfiable, and the workflow destroys the MinIO volumes afterwards.

Two rules keep results trustworthy:

- Assertions read the source of truth — Graph state, S3 keys, exit codes — never Atlas's rendered
  output.
- Everything the suite creates is named `atlas-e2e-<run-id>` and cleanup deletes only that prefix,
  so a bug in the suite cannot touch real mail or files.

## Adding a test

- **New assertion on an existing workload**: one function in the matching `tests/test_*.py`, using
  the existing fixtures (`cli`, `graph`, `s3`, `s3_replica`, `settings`, `run_marker`, `exports`).
- **New workload**: one `tests/test_*.py` plus seed/probe helpers in `atlas_e2e/`.
- Anything created must carry `run_marker` in its name, or teardown will not find it.
- Prefer Graph state and S3 keys over CLI output; never parse the Ink tables (they wrap — #94).
- Fixture bytes are generated at runtime, never committed. Atlas treats content as opaque, so a
  real `.docx` proves nothing a random blob does not. What changes behaviour is **size**:
  `drive.FIXTURE_BYTES` (4 KB) stays on the small-file path, `drive.LARGE_FIXTURE_BYTES` (5 MB)
  crosses chunked download, streaming restore and Graph's 4 MB simple-upload cap. Seed a large one
  with `drive.seed_large_fixture_file`, which uses an upload session because a plain PUT cannot
  carry it. Behaviour that only Graph can produce (OneNote sections, malware-flagged items, IRM)
  lives in the tenant as durable seeded data, discovered by name.

## Running locally

```bash
pnpm run build                                             # the suite runs dist/cli.mjs, not src
docker compose -f e2e/docker-compose.e2e.yml up -d --wait  # MinIO on 9000 (+ replica on 9002)

cd e2e
export E2E_TENANT_ID=...              # Entra tenant GUID
export E2E_CLIENT_ID=...              # the E2E app registration
export E2E_CLIENT_SECRET=...
export E2E_ENCRYPTION_PASSPHRASE=...  # not your production passphrase
export E2E_MAILBOX=you@example.com    # mailbox the suite writes into
export E2E_ONEDRIVE_OWNER=...         # user principal whose drive the suite uses
export E2E_SHAREPOINT_SITE=...        # site URL the suite uses

uv run pytest                         # everything
uv run pytest -k outlook              # one suite
```

The app registration needs admin-consented application permissions; preflight (`-k preflight`)
probes each one and names the missing grant. The list lives in
[`docs/azure-ad-setup.md`](../docs/azure-ad-setup.md).
