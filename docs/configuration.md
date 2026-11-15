---
description: Set Atlas shared settings, Microsoft Entra tenant profiles, and storage options through environment variables, a config file, or the encrypted store.
---

# Configuration

The Atlas CLI reads its settings from environment variables, a `.env` file, a config file, or its encrypted store. Each setting has the same name in every source, so use whichever fits your deployment.

Settings come in two kinds:

- **Shared settings**: S3 access and the encryption passphrase. They apply to every tenant.
- **Tenant profiles**: one Microsoft Entra app registration each. One installation can back up several tenants.

## Quick start

```bash
export ATLAS_TENANT_ID=<tenant-id>
export ATLAS_CLIENT_ID=<client-id>
export ATLAS_CLIENT_SECRET=<client-secret>
export ATLAS_S3_ENDPOINT=https://s3.example.com
export ATLAS_S3_ACCESS_KEY=<access-key>
export ATLAS_S3_SECRET_KEY=<secret-key>
export ATLAS_ENCRYPTION_PASSPHRASE=<passphrase>

atlas config validate              # S3 access to the effective bucket
atlas tenants validate             # Microsoft Graph token for the selected profile
```

The tenant ID, client ID, and client secret come from the [Entra ID app registration](/azure-ad-setup). They apply to whichever profile is selected. To keep several tenants side by side, use [tenant profiles](#tenant-profiles).

::: danger Keep the passphrase safe
The passphrase is the only way to decrypt your backups. If it is lost, the backups cannot be read. See [Security model](/security#kek-derivation-scrypt).
:::

## Settings

Shared settings apply to every tenant profile. Each has an environment variable, a config file field, and an `atlas config` key.

| Environment variable          | Config file field       | `atlas config` key      | Required | Default     | Description                                                                    |
| ----------------------------- | ----------------------- | ----------------------- | -------- | ----------- | ------------------------------------------------------------------------------ |
| `ATLAS_S3_ENDPOINT`           | `s3_endpoint`           | `s3.endpoint`           | Yes      |             | S3 endpoint URL, `https://` or `http://` (for example `http://localhost:9000`) |
| `ATLAS_S3_ACCESS_KEY`         | `s3_access_key`         | `s3.access-key`         | Yes      |             | S3 access key ID                                                               |
| `ATLAS_S3_SECRET_KEY`         | `s3_secret_key`         | `s3.secret-key`         | Yes      |             | S3 secret access key                                                           |
| `ATLAS_S3_REGION`             | `s3_region`             | `s3.region`             | No       | `us-east-1` | S3 region. Lowercase letters, digits, and dashes only                          |
| `ATLAS_ENCRYPTION_PASSPHRASE` | `encryption_passphrase` | `encryption.passphrase` | Yes      |             | Passphrase that wraps the tenant key. At least 14 UTF-8 bytes                  |

Two more variables select what a run works on: `ATLAS_PROFILE` (see [Selecting a profile](#selecting-a-profile)) and `ATLAS_S3_BUCKET` (see [Bucket override](#bucket-override)).

## Tenant profiles

A tenant profile holds one Microsoft Entra app registration: a tenant ID, a client ID, and a client secret. Add a profile, then check that it can sign in:

```bash
pbpaste | atlas tenants add contoso --tenant-id <tenant-id> --client-id <client-id> --client-secret -
atlas tenants validate contoso
```

| Environment variable  | Profile field   | `atlas tenants add` option | Description                                                                                     |
| --------------------- | --------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| `ATLAS_TENANT_ID`     | `tenant_id`     | `--tenant-id`              | Microsoft Entra tenant ID, a GUID or an `*.onmicrosoft.com` domain                              |
| `ATLAS_CLIENT_ID`     | `client_id`     | `--client-id`              | Application (client) ID of the app registration                                                 |
| `ATLAS_CLIENT_SECRET` | `client_secret` | `--client-secret`          | Client secret value. Pass `-` to read it from stdin                                             |
| `ATLAS_S3_BUCKET`     | `bucket`        | `--bucket`                 | Optional. Bucket to use instead of `atlas-<tenant-id>`. See [Bucket override](#bucket-override) |

- **Names.** Lowercase letters, digits, and dashes, up to 32 characters. The name `default` holds the legacy top-level fields described in [Selecting a profile](#selecting-a-profile).
- **Bucket.** A profile's tenant ID also names the bucket that commands read and write, `atlas-<tenant-id>`, unless `-t` overrides the tenant or the profile sets a [bucket override](#bucket-override). Switching profiles switches both the Microsoft 365 tenant and the backup bucket.
- **Shared secrets.** The S3 settings and the passphrase are the same for every profile, so one S3 key and one passphrase reach every profile's bucket. To isolate tenants from each other at the storage layer, see [Bucket isolation](/operations/storage-layout#bucket-isolation).
- **Masking.** The secrets are each profile's client secret, `s3.secret-key`, and `encryption.passphrase`. `atlas config list` and `atlas config get` mask the shared secrets.

::: warning Change the passphrase with atlas keys rewrap
Use `atlas keys rewrap --new-passphrase`, not `atlas config set`. It re-wraps every profile's key first, then stores the new value in the encrypted store when the passphrase came from there. See [Rotation procedure](/security#rotation-procedure).
:::

### Environment variables and profiles

::: warning Environment variables override the selected profile
`ATLAS_TENANT_ID`, `ATLAS_CLIENT_ID`, and `ATLAS_CLIENT_SECRET` replace the selected profile's values. Do not export them while you use several profiles, or one command can mix credentials from two tenants. They never apply to the `--target-profile` of a cross-tenant restore.
:::

Before a command does any work, Atlas checks the three variables against the selected profile:

| Variables set                                         | Result                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| None, or only values equal to the profile's           | Runs silently.                                                                                                |
| Any, with no stored profile selected                  | Runs silently. The variables are the whole identity, as in a CI job that sets all three.                      |
| Any that fill a field the profile leaves empty        | Runs silently. A profile without a secret can take `ATLAS_CLIENT_SECRET` from the environment.                |
| All three, replacing profile values                   | Runs, with a warning on stderr that names the variables and the profile.                                      |
| Some but not all, replacing only the client secret    | Runs, with the same warning. A secret cannot select another tenant or app, so a wrong one fails sign-in.      |
| Some but not all, changing the tenant ID or client ID | Refused with exit code `6` (`ATLAS_CONFIG_INVALID`) before any Microsoft 365 or S3 call, because it mixes identities. |

The warning names the variables, never their values:

```text
[!] Environment variables override tenant profile "contoso" for this run: ATLAS_TENANT_ID, ATLAS_CLIENT_ID, ATLAS_CLIENT_SECRET.
```

### Bucket override

Point a profile or a single run at a bucket with a different name, typically a provider replica on AWS S3 or Backblaze B2, where bucket names are global and a replica cannot carry the primary's name:

```bash
# One run, against a copy of the selected profile's bucket
ATLAS_S3_BUCKET=contoso-replica atlas outlook verify -m user@example.com -s <snapshot-id>

# Permanently, on a profile of its own
atlas tenants add contoso-replica --tenant-id <tenant-id> --client-id <client-id> \
  --client-secret - --bucket contoso-replica
atlas --profile contoso-replica tenants validate
```

The override replaces the bucket name only. The tenant ID still salts the key derived from your passphrase and still binds the wrapped data key, so a copy opens with the same passphrase and tenant ID as the primary, under any name. The override must name a copy of the same tenant's bucket. See [Bucket override](/security#bucket-override) for the threat model.

| Rule                    | Behavior                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Precedence              | `ATLAS_S3_BUCKET` wins over the selected profile's `bucket`.                                                                                                                                                             |
| Bound to a tenant       | A profile's `bucket` belongs to that profile's tenant. When `ATLAS_TENANT_ID` points the run at another tenant, the profile's bucket does not apply.                                                                      |
| Other tenants           | Under `ATLAS_S3_BUCKET`, a command that opens any other tenant (`-t`, `delete --purge -t`, `keys rewrap` over several tenants) refuses it with exit code `6`. Without it, every tenant uses its own profile's bucket. |
| Same tenant twice       | When two profiles name the same tenant with different buckets, the selected profile decides for its own tenant. Opening that tenant from another profile's run is refused as ambiguous.                                 |
| One bucket, two tenants | Refused with exit code `6` when bindings of two different tenants name the same bucket, because a bucket holds one tenant's data key.                                                                                   |
| Never created           | Atlas never creates an overridden bucket, even one named `atlas-<tenant-id>` explicitly. A missing one fails with exit code `6`, so a typo cannot start a second store with a fresh data key.                         |
| Shared setting          | Refused with exit code `6`. A top-level `bucket` in the config file or the store, or `atlas config set s3.bucket`, would apply to every profile.                                                                         |

To remove a profile's bucket, add the profile again with `--replace` and without `--bucket`.

**Read-only credentials.** Credentials scoped read-only to the copy are enough for `verify`, `list`, `status`, `save`, `stats`, and the read side of `restore`, and those commands then write nothing to the bucket. A lookup by email of a user Atlas has not recorded yet normally adds it to the identity registry. When the bucket refuses that write, Atlas logs it at debug level and continues. `atlas storage-check` and `checkStorage()` write and delete one probe object, so they need write access.

## Sources and precedence

Atlas merges sources in this order. A later source overrides an earlier one:

1. **Config file**: `atlas.config.json` or `.atlas/config.json`.
2. **Encrypted secure store**: `~/.atlas/config.enc`, managed with `atlas config` and `atlas tenants`.
3. **`.env` file**: loaded with dotenv. Existing environment variables are not overwritten.
4. **Environment variables**: always win.

Atlas looks for the config file in the current directory first, then in your home directory. In each location it checks `atlas.config.json` before `.atlas/config.json`, and uses the first file found.

Use the config file for shared defaults, the secure store for credentials on operator workstations, and environment variables in CI/CD or containers where secrets are injected at runtime.

The SDK does not read any of these sources. Pass values to `createAtlasInstance` explicitly. See [SDK configuration validation](/reference/sdk#validation).

### Selecting a profile

Each run uses one profile for its Microsoft Entra credentials. The first match wins:

1. `--profile <name>` on the command line, before or after the subcommand.
2. The `ATLAS_PROFILE` environment variable.
3. `active_tenant` in the encrypted store, set by `atlas tenants use`.
4. `active_tenant` in the config file.
5. `default`.

A profile defined in both the config file and the store merges field by field, and the store wins. Legacy top-level `tenant_id`, `client_id`, and `client_secret` fields in either source are read as the `default` profile. The first `atlas tenants` write moves them into `tenants.default`.

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
The file holds each profile's client secret, the S3 secret key, and the encryption passphrase in plaintext. Run `chmod 600` on the config file you use (`atlas.config.json` or `.atlas/config.json`) and on `.env`, and keep them out of version control. Atlas logs a warning at startup when the file is readable by group or others, but it does not refuse to run. See [Configuration file security](/security#configuration-file-security).
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
atlas config validate                        # live S3 check of the effective bucket
```

| Subcommand          | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `list`              | Show every shared key with its value (secrets masked) and its source |
| `get <key>`         | Show one value                                                       |
| `set <key> <value>` | Store a value. Pass `-` as the value to read it from stdin           |
| `unset <key>`       | Remove a stored value                                                |
| `validate`          | Print the effective bucket and send it `HeadBucket`                  |

### Tenant keys are refused

`atlas config set tenant.id`, `client.id`, and `client.secret` fail with a message that points to `atlas tenants add`, because Microsoft Entra credentials belong in a tenant profile. `bucket` and `s3.bucket` are refused the same way: a bucket belongs to one tenant, so set it with `atlas tenants add --bucket` or `ATLAS_S3_BUCKET`.

### Validation on save

`set` checks each value against its key before storing it:

| Key                     | Rule                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| `s3.endpoint`           | Must be an `http://` or `https://` URL                              |
| `s3.region`             | Lowercase letters, digits, and dashes                               |
| `encryption.passphrase` | At least 14 UTF-8 bytes. See [why](/security#kek-derivation-scrypt) |

- Once the endpoint and both S3 keys are present, `set` runs a live S3 probe (`ListBuckets`).
- The passphrase has no live probe. The Microsoft Graph token probe runs with `atlas tenants validate`.
- Because environment variables take precedence, `set` warns when an `ATLAS_*` variable currently overrides the value you are saving.

`atlas config validate` prints the selected profile's effective bucket and sends it `HeadBucket`, which bucket-scoped keys are usually allowed to call where `ListBuckets` is not. A missing `atlas-<tenant-id>` bucket passes, since the first backup creates it. A missing overridden bucket fails. With no tenant ID configured yet, it falls back to `ListBuckets`.

## Invalid configuration

If a required value is missing or malformed, Atlas lists every problem and exits with code `6` (`ATLAS_CONFIG_INVALID`). It never starts a run with partial configuration, because such a run could report success while skipping data. See [CLI exit codes](/reference/cli#exit-codes).

## Buckets and S3 addressing

Each tenant's data lives in a bucket named `atlas-<tenant-id>`.

- **Created on first backup.** Atlas creates the bucket, with the tenant's data key, on the tenant's first backup, and needs `s3:CreateBucket` for that.
- **Never created by other commands.** Every other command, including restore, save, delete, and email lookups, opens only an existing bucket and otherwise fails with `No backups found for tenant <id>`. A profile with the wrong tenant ID therefore leaves no bucket behind. See [S3 permissions by command class](/security#s3-permissions-by-command-class).
- **Name rules.** S3 bucket names are 3 to 63 lowercase letters, digits, dots, or dashes, so the tenant ID must fit in the 57 characters after `atlas-`. `atlas tenants add` stores the tenant ID in lowercase. Before creating a bucket whose name S3 would reject, Atlas stops with a `ConfigError` that names the rule. An existing bucket is used as it is, whatever its name.

::: tip Use the tenant GUID
A domain and the GUID of the same tenant name two different buckets, and a long domain may not fit in a bucket name. Prefer the GUID.
:::

Atlas always addresses buckets in path style (`https://host/bucket-name`, `forcePathStyle: true`). MinIO and most self-hosted S3-compatible services require this form, and AWS S3 accepts it.
