# Outlook backup: an interrupt during the attachment flush drops pending attachments while the folder still counts as complete

**Triage:** RECORD (high confidence in the code path, `bug`, `priority: medium`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

Messages whose MIME capture fails fall back to the JSON payload, and their attachments are fetched
separately in `flush_pending_attachments` after each page. When the run is interrupted during
that flush, the function empties the pending queue and returns. It does not mark the folder
aborted.

`sync_single_folder` only sets `aborted` inside the per-message loop and at the top of the page
callback. If the interrupt arrives after the last message of the final page has been processed,
the page callback returns `true`, the delta sync finishes, and the folder result carries
`complete: true`. `MailboxSyncService` then persists that folder's new delta link.

The messages in the dropped batch are in the manifest with no `attachments` field. The next run
starts after them, so their attachments are never fetched. Nothing records the gap: no
`attachment_errors` line, and `verify` cannot report them as unverifiable because the entries do
not list any attachments.

The run itself does report `interrupted`, because `should_interrupt()` is read again at the end.
The loss is in the folder's delta link, which says the folder was fully processed.

Scope: only messages on the JSON fallback path (MIME capture failed for that message). MIME
entries embed their attachments.

## Steps to reproduce

1. Back up a folder where one or more messages on the last delta page fall back to JSON and have
   attachments.
2. Send SIGINT after the page's messages are processed and while attachments are being fetched
   (the flush runs three at a time, so a page with many such messages leaves a wide window).
3. Run the backup again, then `atlas outlook restore` or `save` the message.

## Expected

An interrupted flush leaves the folder incomplete, so its previous delta link is kept and the
messages are re-fetched next run. Alternatively, each dropped message is reported in
`attachment_errors`.

## Actual

The delta link advances past the messages, and their attachments are never backed up.

## Code references

- `packages/outlook/src/services/backup/folder-sync-executor.ts:120` empties `pending` on
  interrupt without signalling the caller.
- `:254` returns `!aborted` from the page callback, and `:334` returns `complete: !aborted`.
- `packages/outlook/src/services/backup/mailbox-sync.service.ts:150` persists the delta link when
  `complete` is true.

Related: #23 (the original advanced-delta-link-on-interrupt loss) and #366 (attachment failures
kept per message).

## Interface

Both (CLI and SDK).

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

Found by code reading; not reproduced against a live tenant.

## Acceptance criteria

- An interrupt that leaves any pending attachment unfetched marks the folder incomplete, so its
  delta link is not persisted.
- An interrupt that arrives after the flush has finished still lets the folder complete.
- A unit test pins both cases through `sync_single_folder`.
