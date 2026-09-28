# Drive backup: the tenant context is not destroyed when applying default retention fails

**Triage:** RECORD (high confidence, `bug`, `security`, `priority: low`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

`backup_onedrive` and `backup_sharepoint` create the tenant context and then call
`ctx.storage.apply_default_retention` when `--retention-days` is set. That call sits before the
`try` whose `finally` runs `ctx.destroy()`. When it throws, for example with
`ObjectLockUnsupportedError` against a bucket created without Object Lock, the context is never
destroyed, so the passphrase buffer it derived the key-encryption key (KEK) from is not zeroed.

`destroy()` is documented as hygiene, not a guarantee, and a CLI process exits shortly after.
Long-lived SDK hosts that retry a failing backup keep one undestroyed context per attempt. Every
other service in these packages destroys its context on all paths.

## Steps to reproduce

1. Point Atlas at a bucket without Object Lock.
2. `atlas onedrive backup -o john.doe@example.com --retention-days 30`.
3. The run fails fast as documented, and `destroy()` is not called.

## Expected

`ctx.destroy()` runs on every exit path after `create()`.

## Actual

The retention failure leaves the function before the `try` is entered.

## Code references

- `packages/onedrive/src/services/backup/backup.service.ts:73` (create) and `:77` (retention),
  with the `try` starting at `:83`.
- `packages/sharepoint/src/services/backup/backup.service.ts:80` and `:84`, with the `try` at
  `:89`.

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

## Acceptance criteria

- In both services, the retention call runs inside the `try` whose `finally` destroys the context.
- A unit test with a stub context whose `apply_default_retention` rejects asserts that `destroy`
  was called, for both providers.
