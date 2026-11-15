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
- **Outlook options** (`test_12`): `read`, `restore --destination`, a `--folder` or `--message`
  that matches nothing (exit 7, no snapshot written), `save` over an existing file with and
  without `-y`, `outlook mailboxes` and `list-users`. Works on the snapshots `test_10` wrote.
- **Contacts and calendar** (`test_14`, `test_16`): the Outlook shape, in a contact folder and a
  calendar named after the run marker. A second restore must create nothing, and deleting one
  snapshot must leave the other verifiable. Each module skips itself when the app lacks the
  permission, and preflight names the missing grant.
- **OneDrive / SharePoint** (`test_20`, `test_30`): same shape per drive/site, including a second
  file version, a conflict-rename restore, and a 5 MB file that forces chunked download and
  streaming restore instead of the small-file path.
- **OneDrive sharing and rollback** (`test_22`): share a file with an organization link, back it
  up, restore it with and without `--restore-permissions` and read the links back through Graph,
  then roll the file back with `restore-version --before` and compare the sibling's bytes.
  `test_32` runs the same against the SharePoint library, plus `--target-site`.
- **Outlook tree** (`test_13`): a three-level folder tree with a 4 MiB attachment. A full-path
  `--folder` on backup, restore and save, `--message`, `--full`, paging with `-P 2`, a mailbox-mode
  restore that merges snapshots, and a restore into `E2E_SECOND_MAILBOX` when that is set.
- **Drive selection** (`test_33`): `--file-filter` that matches nothing (exit 7) or partly (exit 2),
  the three `--conflict` modes, `--name`, and a deleted file that stays deleted until an
  `--in-place` restore from an earlier snapshot.
- **SDK** (`test_36`): the scripts in `e2e/sdk/` drive the built SDK bundle: configuration and
  option guards, typed errors, listings against S3, progress events, cancellation, verify,
  `readMessage`, a one-message restore, storage request events and `listPermissions`.
- **Regression guards** (`test_35`): one case per shipped bug that only reproduces against real
  infrastructure.
- **Bucket override** (`test_40`): copy the tenant bucket to a second bucket in the same MinIO,
  create a MinIO user that may only read the copy, then run `outlook verify`, `onedrive verify`,
  `sharepoint verify` and `outlook list` against it through `ATLAS_S3_BUCKET`. The copy's version
  listing must be unchanged afterwards. The user is created with `mc` inside the MinIO container
  (`docker exec`); set `E2E_MINIO_CONTAINER` when your MinIO container has another name.
- **Tenant profiles** (`test_45`): a CLI with no Graph identity in its environment and a home of
  its own runs `tenants add`, `list`, `validate`, `use` and `remove`, and reads the bucket with
  `--profile`. Cross-tenant restore needs a second tenant and is tracked in #782.
- **Teams** (`test_60`): back up the team named by `E2E_TEAM_ID`, then `list-snapshots`, `verify`,
  `status`, `save` and `delete -s`. It seeds nothing: posting a channel message needs a signed-in
  user, so the team must already hold at least one message. Skipped when the variable is unset.
- **Run leases** (`test_70`): the suite writes a foreign lease object and runs one command, so
  nothing races. A live lease exits 12 and writes nothing, an expired, released or damaged one is
  taken over, and a tenant command and an owner command refuse each other.
- **Quarantine** (`test_72`): damage one manifest per workload, expect exit 9 naming the key, run
  `quarantine --key`, expect the listing to work again, then put every object version back.
- **Exit codes** (`test_74`): one proof each for 1, 4, 5, 6, 7 and 11, with the bucket's snapshots
  compared before and after. A wrong Graph client secret is an expected failure there until the
  product returns the documented 4.
- **Config store** (`test_76`): `config set`, `get`, `list`, `unset` and `validate` in a home of
  its own: secrets masked and absent from the store file, bad values and tenant keys refused.
- **Passphrase rotation** (`test_80`): `keys rewrap` to a second passphrase, the old one must exit
  5, `keys purge-old-wrappers` must leave one version of `_meta/dek.enc`, then rotate back so the
  deletion suites still open the bucket.
- **Workload deletion** (`test_85`): `onedrive delete` and `sharepoint delete` drop one snapshot
  manifest, keep the shared blobs, and leave the other workloads' objects untouched.
- **Scoped deletes** (`test_87`): `contacts delete -m` and `calendar delete -m` erase every
  version under that mailbox's prefixes and nothing else, `outlook delete -s` drops the newest
  manifest, and a prompt with no answer deletes nothing.
- **Purge** (`test_90`): `delete --purge` must leave an empty bucket.
- **Immutability** (`test_95`): backup with Object Lock → S3 reports the retention → deleting the
  locked object fails. Runs last on purpose: a locked object would make the purge assertion
  unsatisfiable, and the workflow destroys the MinIO volumes afterwards. `test_96` then deletes
  the locked snapshot through Atlas: the objects are reported as retained and the command exits 1.

Two rules keep results trustworthy:

- Assertions read the source of truth — Graph state, S3 keys, exit codes — never Atlas's rendered
  output.
- Everything the suite creates is named `atlas-e2e-<run-id>` and cleanup deletes only that prefix,
  so a bug in the suite cannot touch real mail or files.

## Adding a test

- **New assertion on an existing workload**: one function in the matching `tests/test_*.py`, using
  the existing fixtures (`cli`, `graph`, `s3`, `settings`, `run_marker`, `exports`).
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
docker compose -f e2e/docker-compose.e2e.yml up -d --wait  # MinIO on 9000

cd e2e
export E2E_TENANT_ID=...              # Entra tenant GUID
export E2E_CLIENT_ID=...              # the E2E app registration
export E2E_CLIENT_SECRET=...
export E2E_ENCRYPTION_PASSPHRASE=...  # not your production passphrase
export E2E_MAILBOX=you@example.com    # mailbox the suite writes into
export E2E_ONEDRIVE_OWNER=...         # user principal whose drive the suite uses
export E2E_SHAREPOINT_SITE=...        # site URL the suite uses
export E2E_TEAM_ID=...                # optional: team the Teams suite backs up, read-only
export E2E_SECOND_MAILBOX=...         # optional: second mailbox for the cross-mailbox restore

uv run pytest                         # everything
uv run pytest -k outlook              # one suite
```

The app registration needs admin-consented application permissions; preflight (`-k preflight`)
probes each one and names the missing grant. The list lives in
[`docs/azure-ad-setup.md`](../docs/azure-ad-setup.md).

What the test tenant has to hold beyond the app registration:

| Suite | Needs |
| --- | --- |
| Contacts, calendar | `Contacts.ReadWrite` and `Calendars.ReadWrite` on the app. Both use `E2E_MAILBOX`. The mailbox's own calendars should hold no events, because a calendar backup reads all of them |
| OneDrive and SharePoint sharing | A sharing policy that allows organization links, for the tenant and for the test site |
| Cross-mailbox restore | `E2E_SECOND_MAILBOX`, a second licensed mailbox the app may write to |
| Teams | `E2E_TEAM_ID`, the eight Teams read permissions, and at least one channel message in that team |

## Lint, format and types

```bash
cd e2e
uvx ruff check .          # lint
uvx ruff format .         # format, or --check to only report
uv run mypy .             # types, strict
```

CI runs the same three as the `E2E suite lint, format & types` job, with `--check` on the
formatter. They need no secrets and no tenant, so the gate runs on every pull request while the
suite itself stays nightly.

Config lives in `pyproject.toml`. Two things worth knowing before adding a suppression:

- `S101` (assert) is off for the whole suite, because assertions are its mechanism rather than an
  exception. `PLR2004` is off under `tests/`, where a small literal reads better than a named
  constant, and `S106` is off in `self_check.py`, which has to hold values shaped like credentials
  to prove the redaction boundary.
- `warn_unused_ignores` is on. A `# type: ignore[...]` that stops being needed becomes an error,
  which is what turned up the ones written against a checker that never ran (issue #160). Name the
  narrowest code, never a bare `# type: ignore`.

`ruff format` owns line breaks at 100 columns, matching Prettier's `printWidth` on the TypeScript
side. Do not hand-wrap around it.
