---
description: Set Atlas shared settings, Microsoft Entra tenant profiles, and storage options through environment variables, a config file, or the encrypted store.
---

# Configuration

The Atlas CLI reads settings from environment variables, a config file, or the encrypted store. Shared settings (S3 and the encryption passphrase) apply to every tenant. Microsoft Entra credentials are kept per tenant profile, so one installation can back up several tenants. Each setting has the same name in every source, so you can pick whichever fits your deployment.

## Quick start

```bash
export ATLAS_TENANT_ID=<tenant-id>
export ATLAS_CLIENT_ID=<client-id>
export ATLAS_CLIENT_SECRET=<client-secret>
export ATLAS_S3_ENDPOINT=https://s3.example.com
export ATLAS_S3_ACCESS_KEY=<access-key>
export ATLAS_S3_SECRET_KEY=<secret-key>
export ATLAS_ENCRYPTION_PASSPHRASE=<passphrase>

atlas config validate              # S3 connectivity
atlas tenants validate             # Graph token for the selected profile
```

The tenant ID, client ID, and client secret come from the [Entra ID app registration](/azure-ad-setup). Those variables apply to whichever profile is selected. To keep several tenants side by side, see [Tenant profiles](#tenant-profiles). Keep the passphrase safe: it is the only way to decrypt your backups. See [Security model](/security#kek-derivation-scrypt).

## Settings

Shared settings apply to every tenant profile. Each one has an environment variable, a config file field, and an `atlas config` key.

| Environment variable          | Config file field       | `atlas config` key      | Required | Default     | Description                                                                    |
| ----------------------------- | ----------------------- | ----------------------- | -------- | ----------- | ------------------------------------------------------------------------------ |
| `ATLAS_S3_ENDPOINT`           | `s3_endpoint`           | `s3.endpoint`           | Yes      |             | S3 endpoint URL, `https://` or `http://` (for example `http://localhost:9000`) |
| `ATLAS_S3_ACCESS_KEY`         | `s3_access_key`         | `s3.access-key`         | Yes      |             | S3 access key ID                                                               |
| `ATLAS_S3_SECRET_KEY`         | `s3_secret_key`         | `s3.secret-key`         | Yes      |             | S3 secret access key                                                           |
| `ATLAS_S3_REGION`             | `s3_region`             | `s3.region`             | No       | `us-east-1` | S3 region. Lowercase letters, digits, and dashes only                          |
| `ATLAS_ENCRYPTION_PASSPHRASE` | `encryption_passphrase` | `encryption.passphrase` | Yes      |             | Passphrase that wraps the tenant key. At least 14 UTF-8 bytes                  |

## Tenant profiles

A tenant profile holds one Microsoft Entra app registration: a tenant ID, a client ID, and a client secret. Add profiles with `atlas tenants add`, then check them with `atlas tenants validate`:

```bash
pbpaste | atlas tenants add contoso --tenant-id <tenant-id> --client-id <client-id> --client-secret -
atlas tenants validate contoso
```

| Environment variable  | Profile field   | `atlas tenants add` option | Description                                                        |
| --------------------- | --------------- | -------------------------- | ------------------------------------------------------------------ |
| `ATLAS_TENANT_ID`     | `tenant_id`     | `--tenant-id`              | Microsoft Entra tenant ID, a GUID or an `*.onmicrosoft.com` domain |
| `ATLAS_CLIENT_ID`     | `client_id`     | `--client-id`              | Application (client) ID of the app registration                    |
| `ATLAS_CLIENT_SECRET` | `client_secret` | `--client-secret`          | Client secret value. Pass `-` to read it from stdin                |

Profile names are lowercase letters, digits, and dashes, up to 32 characters. The name `default` holds the legacy top-level fields described in [Selecting a profile](#selecting-a-profile).

A profile's tenant ID also names the bucket that commands read and write, `atlas-<tenant-id>`, unless `-t` overrides it. Switching profiles therefore switches both the Graph tenant and the backup bucket.

Shared settings, including the passphrase, are the same for every profile. One S3 key and one passphrase therefore reach every profile's bucket. To isolate tenants from each other at the storage layer, see [Bucket isolation](/operations/storage-layout#bucket-isolation). The secrets are each profile's client secret, `s3.secret-key`, and `encryption.passphrase`. `atlas config list` and `atlas config get` mask the shared secrets.

::: warning Environment variables override the selected profile
`ATLAS_TENANT_ID`, `ATLAS_CLIENT_ID`, and `ATLAS_CLIENT_SECRET` replace the selected profile's values. Do not export them while you use several profiles, or one command can mix credentials from two tenants. They never apply to the `--target-profile` of a cross-tenant restore.
:::

## Sources and precedence

Atlas merges sources in this order. A later source overrides an earlier one:

1. **Config file**: `atlas.config.json` or `.atlas/config.json`.
2. **Encrypted secure store**: `~/.atlas/config.enc`, managed with `atlas config` and `atlas tenants`.
3. **`.env` file**: loaded with dotenv. Existing environment variables are not overwritten.
4. **Environment variables**: always win.

Atlas searches for the config file in the current directory first, then in your home directory. In each location it checks `atlas.config.json` before `.atlas/config.json`, and it uses the first file found.

Use the config file for shared defaults, the secure store for credentials on operator workstations, and environment variables for CI/CD or containers where secrets are injected at runtime.

### Selecting a profile

Each run uses one profile for Graph credentials. The first match wins:

1. `--profile <name>` on the command line. It works before or after the subcommand.
2. The `ATLAS_PROFILE` environment variable.
3. `active_tenant` in the encrypted store, set by `atlas tenants use`.
4. `active_tenant` in the config file.
5. `default`.

A profile defined in both the config file and the store merges field by field, and the store wins. Legacy top-level `tenant_id`, `client_id`, and `client_secret` fields in either source are read as the `default` profile. The first `atlas tenants` write moves them into `tenants.default`.

The SDK does not read these sources. Pass values to `createAtlasInstance` explicitly. See [SDK configuration validation](/reference/sdk#validation).

## Config file

```json
{
  "s3_endpoint": "http://localhost:9000",
  "s3_access_key": "<access-key>",
  "s3_secret_key": "<secret-key>",
  "encryption_passphrase": "<passphrase>",
  "active_tenant": "contoso",
  "tenants": {
    "contoso": {
      "tenant_id": "<tenant-id>",
      "client_id": "<client-id>",
      "client_secret": "<client-secret>"
    },
    "fabrikam": {
      "tenant_id": "<tenant-id>",
      "client_id": "<client-id>",
      "client_secret": "<client-secret>"
    }
  }
}
```

::: danger Restrict the config file to its owner
The file holds each profile's client secret, the S3 secret key, and the encryption passphrase in plaintext. Run `chmod 600` on the config file you use (`atlas.config.json` or `.atlas/config.json`) and on `.env`, and keep the file out of version control. Atlas logs a warning at startup when the file is readable by group or others, but it does not refuse to run. See [Configuration file security](/security#configuration-file-security).
:::

## Managing values with `atlas config`

`atlas config` writes shared settings to the encrypted store at `~/.atlas/config.enc`. Values are never stored in plaintext. Tenant credentials are managed with [`atlas tenants`](#tenant-profiles) instead.

```bash
atlas config set s3.endpoint https://s3.example.com
atlas config set s3.access-key <access-key>
pbpaste | atlas config set s3.secret-key -   # "-" reads the value from stdin, keeping it out of shell history
atlas config list                            # shared keys, secrets masked, source annotated
atlas config get s3.endpoint
atlas config unset s3.access-key
atlas config validate                        # live S3 connectivity check
```

| Subcommand          | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `list`              | Show every shared key with its value (secrets masked) and its source |
| `get <key>`         | Show one value                                                       |
| `set <key> <value>` | Store a value. Pass `-` as the value to read it from stdin           |
| `unset <key>`       | Remove a stored value                                                |
| `validate`          | Probe S3 `ListBuckets`                                               |

### Tenant keys are refused

`atlas config set tenant.id`, `client.id`, and `client.secret` fail with a message that points to `atlas tenants add`. Graph credentials belong in a tenant profile.

### Validation on save

`set` checks each value against its key before storing it. A live S3 probe (`ListBuckets`) runs once the endpoint and both S3 keys are present. The passphrase has no live probe. `atlas config validate` runs the S3 probe on demand. The Graph token probe runs with `atlas tenants validate`.

Format rules:

| Key                     | Rule                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| `s3.endpoint`           | Must be an `http://` or `https://` URL                              |
| `s3.region`             | Lowercase letters, digits, and dashes                               |
| `encryption.passphrase` | At least 14 UTF-8 bytes. See [why](/security#kek-derivation-scrypt) |

Because environment variables take precedence, `set` warns when an `ATLAS_*` variable currently overrides the value you are saving.

## Invalid configuration

If a required value is missing or malformed, Atlas exits with an error that lists every problem, and it exits with code `6` (`ATLAS_CONFIG_INVALID`). A run that starts with partial configuration could report success while skipping data, so Atlas fails fast instead. See [CLI exit codes](/reference/cli#exit-codes).

## S3 path-style addressing

Atlas always addresses buckets in path style (`https://host/bucket-name`) by setting `forcePathStyle: true`. MinIO and most self-hosted S3-compatible services require this form. AWS S3 accepts it as well.

Each tenant's data lives in a bucket named `atlas-<tenant-id>`. Atlas creates it on first backup, and it needs `s3:CreateBucket` for that. See [S3 permissions by command class](/security#s3-permissions-by-command-class).

## Replication target config

`atlas replicate` takes `--target-config`, and `atlas rehydrate` takes `--source-config`. Each points to a JSON file with the credentials for one secondary storage target:

```json
{
  "target_id": "offsite-dr",
  "s3_endpoint": "https://offsite.example.com",
  "s3_access_key": "offsite-key",
  "s3_secret_key": "offsite-secret",
  "s3_region": "us-east-1"
}
```

| Field           | Required | Description                                            |
| --------------- | -------- | ------------------------------------------------------ |
| `target_id`     | No       | Stable identifier for the target. Generated if omitted |
| `s3_endpoint`   | Yes      | S3 endpoint URL for the target                         |
| `s3_access_key` | Yes      | Access key for the target                              |
| `s3_secret_key` | Yes      | Secret key for the target                              |
| `s3_region`     | No       | Region for the target. Default `us-east-1`             |

The encryption passphrase is not in this file. All targets share the primary's passphrase and tenant key, so a target config holds only storage credentials. Atlas refuses to replicate to a target whose key differs from the primary's. See [Replication security](/security#replication-security).

::: danger Restrict target config files too
Target config files hold S3 credentials. Apply the same `chmod 600` rule as the main config file, and keep them out of version control.
:::

See also: [Security model](/security), [Entra ID app registration](/azure-ad-setup), [CLI reference](/reference/cli).
