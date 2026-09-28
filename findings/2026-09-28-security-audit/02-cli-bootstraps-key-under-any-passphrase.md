# The CLI creates a new tenant key under a passphrase of any length, while the SDK and key rewrap require 14 bytes

**Triage:** RECORD (high confidence, `bug`, `security`, `priority: medium`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

Under Kerckhoffs's principle the passphrase is the only secret. The wrapped data key
`_meta/dek.enc` sits in the same bucket as the data, and its KDF parameters (scrypt N=65536,
r=8, p=1, 32-byte salt) are stored in the clear in its header, as they should be. Anyone with
read access to the bucket can therefore run an offline guessing attack on the passphrase, and
its length and entropy are the whole defence.

Three code paths set or accept that passphrase, with three different rules:

| Path                                                         | Rule                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| SDK `createAtlasInstance`                                    | Rejects fewer than 14 UTF-8 bytes (`ConfigError`)    |
| `atlas keys rewrap` (new passphrase)                         | Rejects fewer than 14 UTF-8 bytes                    |
| `atlas config set encryption.passphrase`                     | Rejects fewer than 12 characters (UTF-16 code units) |
| CLI via `ATLAS_ENCRYPTION_PASSPHRASE` or `atlas.config.json` | Accepts any non-empty value                          |

The last row is the one that creates keys. The first backup of a new tenant calls
`create_dek_exclusively`, which wraps a fresh data key under whatever passphrase the CLI loaded,
and `ScryptKdfStrategy.generate_params` only logs a warning below 14 characters. A tenant whose
whole backup is protected by a four-character passphrase is one environment variable away.

`docs/security.md:50` explains why the CLI was left alone: existing backups made with a short
passphrase must stay readable. That argument covers unwrapping an existing key. It does not
cover creating a new one, where refusing a short passphrase strands nothing.

## Steps to reproduce

1. `ATLAS_ENCRYPTION_PASSPHRASE=abcd atlas outlook backup -m john.doe@example.com -t <new-tenant>`
2. The run warns and succeeds, and `_meta/dek.enc` is wrapped under `abcd`.
3. The same value in `createAtlasInstance` fails with `ConfigError`, and
   `atlas keys rewrap` refuses it as a new passphrase.

## Expected

Creating a new data key, from any entry point, requires the same minimum the SDK and rewrap
already enforce. Unwrapping an existing key under a short passphrase keeps working, with the
warning.

## Actual

The CLI creates the key and warns.

## Code references

- `packages/s3/src/adapters/tenant-context.factory.ts:102-111`, key creation.
- `packages/core/src/adapters/keystore/kdf-strategy.ts:70-77`, warning only.
- `packages/core/src/utils/config.ts:135-151`, presence check only.
- `packages/core/src/utils/config-keys.ts:5`, the 12-character rule.
- `packages/sdk/src/instance-config.ts:19` and
  `packages/core/src/services/keys/dek-rewrap.service.ts:213`, the 14-byte rule.
- `docs/security.md:50`, `docs/configuration.md:57`.

## Interface

CLI.

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

Found by code reading.

## Acceptance criteria

- Creating a tenant data key refuses a passphrase under 14 UTF-8 bytes on every path, with
  `ConfigError`.
- Opening an existing key under a shorter passphrase still works and still warns.
- `atlas config set encryption.passphrase` uses the same 14-byte rule.
- One constant defines the minimum.
- `docs/security.md` and `docs/configuration.md` state the rule once, for new keys and for
  existing ones.
