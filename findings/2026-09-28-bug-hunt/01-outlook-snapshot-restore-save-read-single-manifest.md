# Outlook restore -s and save -s read a single delta manifest, while verify -s folds the chain

**Triage:** RECORD (high confidence, `bug`, `priority: high`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

An Outlook snapshot manifest holds only the messages the delta sync returned in that run. The
first backup of a mailbox is a full enumeration. Every later backup records only what changed.

`atlas outlook verify -s` resolves the snapshot's manifest chain (the target plus every older
manifest for the mailbox) and checks the merged set. `atlas outlook restore -s` and
`atlas outlook save -s` do not. Both load the one manifest and iterate `manifest.entries`, so
restoring or exporting the newest snapshot of a mailbox that has had incremental runs brings back
only the messages that changed in the last run. Everything captured earlier is still in the
bucket, encrypted and verified, but snapshot mode never reaches it.

Verification does not catch it, because verification checks a different, larger set than restore
writes. A snapshot whose restore returns 3 messages out of 10,000 verifies as healthy.

This is the defect #173 fixed for OneDrive and SharePoint. #173 recorded Outlook as unaffected
because `restore` and `save` fold the chain, which is true only of mailbox mode (`-m`). Snapshot
mode (`-s`) was never brought along.

## Steps to reproduce

1. `atlas outlook backup -m john.doe@example.com` against a mailbox with messages A and B. This
   is snapshot 1 and contains both.
2. Deliver one new message C.
3. `atlas outlook backup -m john.doe@example.com`. Snapshot 2 contains only C.
4. `atlas outlook verify -s <snapshot-2>`: 3 checked, 3 passed.
5. `atlas outlook save -s <snapshot-2> --output out.zip`: the archive holds one `.eml`.
6. `atlas outlook restore -s <snapshot-2>`: one message is restored.

## Expected

Snapshot 2 is a point-in-time view of the mailbox, as it is for the drive workloads and as
`verify` already treats it. `save -s` exports A, B and C, and `restore -s` restores all three.

## Actual

`save -s` and `restore -s` act on C only. A and B are skipped with no warning and the run exits 0.

## Code references

Snapshot mode reads a single manifest:

- `packages/outlook/src/services/restore/restore.service.ts:59` loads the manifest, and
  `resolve_entries` at `:208` filters `manifest.entries`.
- `packages/outlook/src/services/save/save.service.ts:61` and `:169`, the same shape.

The chain resolution that already exists and is not used here:

- `packages/core/src/services/verification/verification.service.ts:106` `load_manifest_chain`
- `packages/core/src/services/shared/manifest-entry-merger.ts:27` `merge_snapshot_entries`

Mailbox mode (`restore_mailbox`, `save_mailbox`) does merge, which is why #173 read Outlook as
unaffected.

The documentation promises the behaviour the code does not have:

- `docs/reference/cli.md:254`: verification "is the same routine restore uses, so the two views
  cannot drift".
- `docs/reference/cli.md:417`: "`save` walks the whole snapshot chain".

No unit test covers chain resolution in snapshot mode. `restore.service.test.ts` and
`save.service.test.ts` exercise single manifests only.

## Interface

Both (CLI and SDK). `restore_snapshot` and `save_snapshot` are the SDK entry points.

## Environment

```
OS: Ubuntu 24.04.4 LTS
Kernel: 6.18.44-fc-v42
Arch: x86_64
Node: v22.22.2
pnpm: 10.30.3
Atlas: 5.2.2
Git commit: 4d6ee39 (clean)
```

Found by code reading; no live tenant run.

## Acceptance criteria

- `outlook restore -s` and `outlook save -s` resolve the same manifest chain `outlook verify -s`
  does: the target plus older manifests for the same mailbox, merged newest-first by `object_id`.
- Manifests newer than the target and manifests of other mailboxes are excluded.
- A message captured in snapshot 1 and untouched afterwards is restored and exported from
  snapshot N.
- `-f` / folder filtering and the Recoverable Items policy apply to the merged set.
- `--message <n>` resolves against the same list `outlook list -s` shows, so an index never means
  a different message between the two commands. If `list -s` keeps showing the delta only, that
  choice is stated in the docs.
- Unit tests in both services pin chain resolution, including version precedence (the newest
  entry for an `object_id` wins).
- `docs/reference/cli.md` states that an Outlook snapshot restore or export draws from the delta
  chain.
