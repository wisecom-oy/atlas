# Configuration

Atlas merges configuration from four sources, in this order. Later sources win.

1. **Config file**: `atlas.config.json` or `.atlas/config.json`, searched in cwd, then `~/.atlas/`
2. **Encrypted secure store**: `~/.atlas/config.enc`, managed with `atlas config`
3. **`.env` file**: loaded via dotenv, and does not overwrite existing environment variables
4. **Environment variables**: always take precedence

This lets you keep defaults in a config file, credentials in the encrypted store on operator workstations, and environment variables for CI/CD or container orchestration where secrets are injected at runtime.

## Variables

Every setting has three equivalent forms: an environment variable, a config file field, and an `atlas config` key for the encrypted store.

### Microsoft 365 credentials

| Variable              | Config field    | `atlas config` key | Required | Description                    |
| --------------------- | --------------- | ------------------ | -------- | ------------------------------ |
| `ATLAS_TENANT_ID`     | `tenant_id`     | `tenant.id`        | yes      | Azure AD tenant ID             |
| `ATLAS_CLIENT_ID`     | `client_id`     | `client.id`        | yes      | App registration client ID     |
| `ATLAS_CLIENT_SECRET` | `client_secret` | `client.secret`    | yes      | App registration client secret |

### S3 storage

| Variable              | Config field    | `atlas config` key | Required | Description                                    |
| --------------------- | --------------- | ------------------ | -------- | ---------------------------------------------- |
| `ATLAS_S3_ENDPOINT`   | `s3_endpoint`   | `s3.endpoint`      | yes      | S3 endpoint URL (e.g. `http://localhost:9000`) |
| `ATLAS_S3_ACCESS_KEY` | `s3_access_key` | `s3.access-key`    | yes      | S3 access key                                  |
| `ATLAS_S3_SECRET_KEY` | `s3_secret_key` | `s3.secret-key`    | yes      | S3 secret key                                  |
| `ATLAS_S3_REGION`     | `s3_region`     | `s3.region`        | no       | S3 region (default: `us-east-1`)               |

### Encryption

| Variable                      | Config field            | `atlas config` key      | Required | Description                               |
| ----------------------------- | ----------------------- | ----------------------- | -------- | ----------------------------------------- |
| `ATLAS_ENCRYPTION_PASSPHRASE` | `encryption_passphrase` | `encryption.passphrase` | yes      | Master passphrase for envelope encryption |

## The Encrypted Secure Store (`atlas config`)

```bash
atlas config tenant.id 4fa2a706-b26a-4bbe-9b1c-1e671b586b8f
atlas config client.id 11112222-3333-4444-5555-666677778888
pbpaste | atlas config client.secret -   # "-" reads from stdin, keeping secrets out of shell history
atlas config s3.endpoint https://s3.example.com
atlas config list          # every key, secrets masked, source annotated
atlas config validate      # live-check Graph and S3 connectivity
atlas config unset client.secret
```

Plaintext files and environment variables are readable by any process running as your user. Environment-grabbing malware routinely sweeps `~/.env`, shell profiles, and process environments. `atlas config` instead persists values to `~/.atlas/config.enc`, encrypted with AES-256-GCM.

The 256-bit store key never sits next to the ciphertext. It lives in the **macOS Keychain** (via `security`) or **libsecret** on Linux (via `secret-tool`). Only when neither keyring is available does Atlas fall back to a `~/.atlas/config.key` file (mode `0600`), and it warns loudly when it does.

Values are validated on save: format checks per key (GUID, URL, minimum passphrase length), plus a live connectivity probe (Graph token request, S3 `ListBuckets`) as soon as a credential group is complete.

Because environment variables still win, `atlas config` warns when a saved value is currently shadowed by an `ATLAS_*` variable.

## Config File Example

```json
{
  "tenant_id": "your-azure-tenant-id",
  "client_id": "app-client-id",
  "client_secret": "app-client-secret",
  "s3_endpoint": "http://localhost:9000",
  "s3_access_key": "minioadmin",
  "s3_secret_key": "minioadmin",
  "encryption_passphrase": "my-secret-passphrase"
}
```

Atlas loads the first config file it finds, searching in this order:

1. `./atlas.config.json`
2. `./.atlas/config.json`
3. `~/.atlas/config.json`

Values from the config file can be overridden by `.env` entries and environment variables.

## Invalid Configuration

If a required field is missing or invalid, Atlas exits immediately with an error listing every missing field. It will not start a backup with partial configuration. This fail-fast behavior prevents silent failures where a run appears successful but is missing critical settings like the encryption passphrase.

## S3 Path Style

Atlas uses `forcePathStyle: true` when constructing the S3 client. This is **required** for MinIO and most self-hosted S3-compatible endpoints, which use path-style URLs (`http://host:9000/bucket-name`) rather than virtual-hosted-style (`http://bucket-name.host:9000`). AWS S3 supports both styles, so the setting is compatible there too.

::: danger Secure Your Configuration Files
The config file and `.env` file contain sensitive credentials: Azure client secrets, S3 access keys, and the encryption passphrase. On Linux, restrict file permissions immediately:

```bash
chmod 600 .env atlas.config.json
```

Atlas enforces this at runtime. On Unix systems, if a config file has group- or world-readable bits set (`mode & 0o077 !== 0`), a warning is logged recommending `chmod 600`. It is a warning rather than a hard error to avoid breaking existing deployments, but address it promptly.

Never commit these files to version control. The included `.gitignore` already excludes `.env`, but verify that your config file is also excluded. In multi-user environments, ensure only the service account running Atlas can read these files.
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
Target config files contain S3 credentials. Apply the same file permission restrictions as the main config file (`chmod 600`). Never commit them to version control.
:::
