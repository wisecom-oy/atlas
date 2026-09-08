# Configuration

The Atlas CLI reads configuration from two sources. Later wins.

1. **Encrypted secure store**: `~/.atlas/config.enc`, written with `atlas config set`. The recommended source, and the only one that does not leave credentials readable on disk.
2. **Environment variables**: `ATLAS_*`, either exported or read from a `.env` file in the directory Atlas runs in.

Use the store on a workstation or a long-lived host, and environment variables where a platform injects secrets at runtime: containers, CI, a scheduled job with a unit-file environment.

Earlier versions also read a plaintext `atlas.config.json`. v5.0.0 does not read it at all; see [Migrating to v5](/migration/v5#configuration-sources) for the commands that replace it.

The SDK uses neither source. Pass credentials and tenant configuration explicitly to `createAtlasInstance`; v5 rejects missing or blank required fields, passphrases shorter than 14 UTF-8 bytes, and malformed HTTP(S) S3 endpoints before creating clients. The optional `atlas.validate()` probes an existing tenant bucket and Graph token acquisition without provisioning storage. See [SDK configuration validation](/reference/sdk#configuration-validation) for endpoint constraints and typed failures.

## Variables

Every setting has two equivalent forms: an `atlas config` key for the encrypted store, and an environment variable.

### Microsoft 365 credentials

| Variable              | `atlas config` key | Required | Description                    |
| --------------------- | ------------------ | -------- | ------------------------------ |
| `ATLAS_TENANT_ID`     | `tenant.id`        | yes      | Azure AD tenant ID             |
| `ATLAS_CLIENT_ID`     | `client.id`        | yes      | App registration client ID     |
| `ATLAS_CLIENT_SECRET` | `client.secret`    | yes      | App registration client secret |

### S3 storage

| Variable              | `atlas config` key | Required | Description                                    |
| --------------------- | ------------------ | -------- | ---------------------------------------------- |
| `ATLAS_S3_ENDPOINT`   | `s3.endpoint`      | yes      | S3 endpoint URL (e.g. `http://localhost:9000`) |
| `ATLAS_S3_ACCESS_KEY` | `s3.access-key`    | yes      | S3 access key                                  |
| `ATLAS_S3_SECRET_KEY` | `s3.secret-key`    | yes      | S3 secret key                                  |
| `ATLAS_S3_REGION`     | `s3.region`        | no       | S3 region (default: `us-east-1`)               |

### Encryption

| Variable                      | `atlas config` key      | Required | Description                               |
| ----------------------------- | ----------------------- | -------- | ----------------------------------------- |
| `ATLAS_ENCRYPTION_PASSPHRASE` | `encryption.passphrase` | yes      | Master passphrase for envelope encryption |

## The Encrypted Secure Store (`atlas config`), Recommended

```bash
atlas config set tenant.id 4fa2a706-b26a-4bbe-9b1c-1e671b586b8f
atlas config set client.id 11112222-3333-4444-5555-666677778888
pbpaste | atlas config set client.secret -   # "-" reads from stdin, keeping secrets out of shell history
atlas config set s3.endpoint https://s3.example.com
atlas config list          # every key, secrets masked, source annotated
atlas config validate      # live-check Graph and S3 connectivity
atlas config unset client.secret
```

Plaintext files and environment variables are readable by any process running as your user. Environment-grabbing malware routinely sweeps `~/.env`, shell profiles, and process environments. `atlas config` instead persists values to `~/.atlas/config.enc`, encrypted with AES-256-GCM.

The 256-bit store key never sits next to the ciphertext. It lives in the **macOS Keychain** (via `security`) or **libsecret** on Linux (via `secret-tool`). Only when neither keyring is available does Atlas fall back to a `~/.atlas/config.key` file (mode `0600`), and it warns loudly when it does.

Values are validated on save: format checks per key (GUID, URL, minimum passphrase length), plus a live connectivity probe (Graph token request, S3 `ListBuckets`) as soon as a credential group is complete.

Because environment variables still win, `atlas config` warns when a saved value is currently shadowed by an `ATLAS_*` variable.

## Environment Variables and `.env`

```bash
export ATLAS_TENANT_ID=4fa2a706-b26a-4bbe-9b1c-1e671b586b8f
atlas outlook backup -m john.doe@example.com
```

A `.env` file in the working directory is loaded for the same variables, and does not overwrite one that is already exported. This is the source to use where the platform owns the secrets: a container's environment, a CI job's masked variables, a systemd unit's `EnvironmentFile`.

It is also the weaker source. A `.env` file is plaintext, and any process running as the same user can read both it and the environment of a running Atlas process. Prefer `atlas config set` wherever a person, rather than a platform, is supplying the value.

## Invalid Configuration

If a required field is missing or invalid, Atlas exits immediately with an error listing every missing field and naming both sources. It will not start a backup with partial configuration. This fail-fast behavior prevents silent failures where a run appears successful but is missing critical settings like the encryption passphrase.

## S3 Path Style

Atlas uses `forcePathStyle: true` when constructing the S3 client. This is **required** for MinIO and most self-hosted S3-compatible endpoints, which use path-style URLs (`http://host:9000/bucket-name`) rather than virtual-hosted-style (`http://bucket-name.host:9000`). AWS S3 supports both styles, so the setting is compatible there too.

::: danger Secure your `.env` file
A `.env` file holds sensitive credentials in plaintext: Azure client secrets, S3 access keys, and the encryption passphrase. On Linux, restrict its permissions immediately:

```bash
chmod 600 .env
```

Never commit it. The included `.gitignore` already excludes `.env`. In multi-user environments, ensure only the service account running Atlas can read it, and prefer `atlas config set`, which stores the same values encrypted with the key held in the OS keyring.
:::

## Replication Target Config

`atlas replicate` accepts `--target-config` and `atlas rehydrate` accepts `--source-config`. Both point to a JSON file holding S3 credentials for a secondary storage target:

```json
{
  "target_id": "offsite-dr",
  "s3_endpoint": "http://offsite:9000",
  "s3_access_key": "offsite-key",
  "s3_secret_key": "offsite-secret",
  "s3_region": "us-east-1"
}
```

| Field           | Required | Description                                        |
| --------------- | -------- | -------------------------------------------------- |
| `target_id`     | no       | Stable human-readable ID (auto-derived if omitted) |
| `s3_endpoint`   | yes      | S3 endpoint URL for the target                     |
| `s3_access_key` | yes      | S3 access key for the target                       |
| `s3_secret_key` | yes      | S3 secret key for the target                       |
| `s3_region`     | no       | S3 region (default: `us-east-1`)                   |

The encryption passphrase is **not** included in this file. Atlas uses a shared encryption model, so the passphrase from the main configuration applies to all targets.

::: danger Secure Target Config Files
Target config files contain S3 credentials, so restrict them to the owner (`chmod 600`). Never commit them to version control. They are the one JSON file Atlas still reads: a peer target has no encrypted-store or environment equivalent.
:::
