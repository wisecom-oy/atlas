# Live-Tenant E2E Validation

Atlas's unit suites mock Microsoft Graph and S3. That is the right default -- they run in seconds and gate every push -- but it means no unit test can catch a Graph endpoint that changes its contract, a permission that was never granted, or an S3 backend that silently declines to apply Object Lock. Those defects only exist against real infrastructure.

The E2E pipeline exists to find them on a schedule instead of in production. It lives in `e2e/` and drives **the shipped CLI bundle** (`packages/cli/dist/cli.mjs`) against a real Microsoft 365 tenant, with MinIO providing S3 storage inside the GitHub Actions runner.

```bash
# from e2e/, with the seven E2E_* variables in the environment
pnpm run build          # the suite runs dist/, not src
docker compose -f docker-compose.e2e.yml up -d --wait
uv run pytest           # ~35 tests, roughly two minutes
```

Full setup, fixtures, and the safety model are documented in [`e2e/README.md`](https://github.com/wisecom-oy/atlas/blob/main/e2e/README.md).

## What a run proves

Each suite is a lifecycle, not a collection of assertions -- every step depends on the previous one, so a break anywhere stops the chain.

| Suite                  | Proves                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `test_00_preflight`    | Every Graph permission the product calls is granted and consented; the S3 bucket is lock-capable             |
| `test_10_outlook`      | Seed → backup → list → verify → save → delete from M365 → restore → compare through Graph → incremental      |
| `test_20_onedrive`     | Two file versions → backup → per-file version index → restore with conflict rename → SHA-256 compare         |
| `test_30_sharepoint`   | The same lifecycle per site, plus URL, short-form, and composite site identifiers addressing one stored tree |
| `test_35_regressions`  | One case per shipped bug that only reproduces against real infrastructure                                    |
| `test_40_replication`  | Replicate → **destroy primary** → rehydrate from the replica → verify decryption under the recovered key     |
| `test_90_purge`        | `delete --purge` empties the bucket                                                                          |
| `test_95_immutability` | Object Lock retention is applied and a blocked delete is reported as _retained_, not _failed_                |

Two design rules make the results trustworthy:

- **Assertions read the source of truth, not Atlas's output.** Restores are verified through Graph, storage through the S3 API, exit codes as exit codes. A tool that prints "restored 1 item" is not evidence that an item was restored.
- **No automatic retry.** A retry that turns red into green hides exactly the flakiness the pipeline exists to surface.

## Schedule

| Trigger                   | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| Weekly, Monday 03:00 UTC  | Standing guard, governance-mode Object Lock                                   |
| Monthly, 1st at 04:00 UTC | Compliance-mode leg: retention that cannot be lifted early, even by the owner |
| Push to `main` / `dev`    | Catches a break at the moment it lands rather than days later                 |
| `workflow_dispatch`       | Ad-hoc, with a `-k` expression and a lock-mode choice                         |

The workflow **never** triggers on `pull_request`. It holds tenant credentials, and a PR-triggered run of fork-supplied code would be a straightforward secret-exfiltration path. It is also deliberately **not a required status check**: a live-tenant run depends on Graph and network availability, so a red E2E must inform an engineer, not block an unrelated merge. `ci.yml` remains the gate.

## Security model for a public repository

The tenant is real, the repository is open source, and Actions artifacts are public downloads. Three consequences shape the implementation:

- **Everything identifying is a secret**, including the tenant id, mailbox address, OneDrive owner, and SharePoint site URL -- not just credentials. Derived values are masked too: the bucket name embeds the tenant id, so the workflow registers it with `::add-mask::` before first use.
- **Artifacts are scrubbed on write, not on upload.** The CLI transcript passes through `atlas_e2e.scrub`, which replaces known secret values and then templates identifying _shapes_ -- GUIDs, bearer tokens, UPNs, Graph drive ids. A file that was never allowed to hold a secret cannot leak one later.
- **The upload is gated by a check, not by trust.** A workflow step greps the artifacts for each secret value and fails the job before upload if any appears. It compares without ever echoing the values.

Failure messages follow the same rule: marker names and counts, never message bodies or file contents.

## Cleanup

Every artifact the suite creates carries a run marker (`atlas-e2e-<run-id>`), and cleanup only ever deletes objects whose names match it. A bug in the suite therefore cannot destroy real data in the tenant. Teardown also removes markers older than 24 hours, so a run killed mid-flight does not leak fixtures forever.

Storage is destroyed at two layers: the suite asserts the product's own erasure path (`delete --purge` leaves an empty bucket), and the workflow then removes the MinIO volumes outright -- so no ciphertext and no wrapped key survives the job even when the purge assertion is the thing that failed.
