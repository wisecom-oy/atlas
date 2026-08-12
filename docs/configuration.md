# Configuration

Atlas loads configuration from four sources, merged in this order (later wins):

1. **Config file** — `atlas.config.json` or `.atlas/config.json` (searched in cwd, then `~/.atlas/`)
2. **Encrypted secure store** — `~/.atlas/config.enc`, managed with `atlas config` (see below)
3. **`.env` file** — loaded via dotenv; does not overwrite existing environment variables
4. **Environment variables** — always take precedence

This precedence means you can set defaults in a config file, keep credentials in the encrypted store on operator workstations, and use environment variables for CI/CD or container orchestration where secrets are injected at runtime.

## Reference

| Variable                      | Config field            | Required | Description                                    |
| ----------------------------- | ----------------------- | -------- | ---------------------------------------------- |
| `ATLAS_TENANT_ID`             | `tenant_id`             | yes      | Azure AD tenant ID                             |
| `ATLAS_CLIENT_ID`             | `client_id`             | yes      | App registration client ID                     |
| `ATLAS_CLIENT_SECRET`         | `client_secret`         | yes      | App registration client secret                 |
| `ATLAS_S3_ENDPOINT`           | `s3_endpoint`           | yes      | S3 endpoint URL (e.g. `http://localhost:9000`) |
| `ATLAS_S3_ACCESS_KEY`         | `s3_access_key`         | yes      | S3 access key                                  |
| `ATLAS_S3_SECRET_KEY`         | `s3_secret_key`         | yes      | S3 secret key                                  |
| `ATLAS_S3_REGION`             | `s3_region`             | no       | S3 region (default: `us-east-1`)               |
| `ATLAS_ENCRYPTION_PASSPHRASE` | `encryption_passphrase` | yes      | Master passphrase for envelope encryption      |

## The Encrypted Secure Store (`atlas config`)

Storing credentials in plaintext files or environment variables leaves them readable by any process running as your user — environment-grabbing malware routinely sweeps `~/.env`, shell profiles, and process environments. The `atlas config` command instead persists values to `~/.atlas/config.enc`, encrypted with AES-256-GCM:

```bash
atlas config tenant.id 4fa2a706-b26a-4bbe-9b1c-1e671b586b8f
atlas config client.id 11112222-3333-4444-5555-666677778888
pbpaste | atlas config client.secret -   # "-" reads from stdin, keeping secrets out of shell history
atlas config s3.endpoint https://s3.example.com
atlas config list          # every key, secrets masked, source annotated
atlas config validate      # live-check Graph and S3 connectivity
atlas config unset client.secret
```

| CLI key                 | Config field            |
| ----------------------- | ----------------------- |
| `tenant.id`             | `tenant_id`             |
| `client.id`             | `client_id`             |
| `client.secret`         | `client_secret`         |
| `s3.endpoint`           | `s3_endpoint`           |
| `s3.access-key`         | `s3_access_key`         |
| `s3.secret-key`         | `s3_secret_key`         |
| `s3.region`             | `s3_region`             |
| `encryption.passphrase` | `encryption_passphrase` |

The 256-bit store key never sits next to the ciphertext: it lives in the **macOS Keychain** (via `security`) or **libsecret** on Linux (via `secret-tool`). Only when neither keyring is available does Atlas fall back to a `~/.atlas/config.key` file (mode `0600`) and warns loudly. Values are validated on save — format checks per key (GUID, URL, minimum passphrase length), plus a live connectivity probe (Graph token request, S3 `ListBuckets`) as soon as a credential group is complete.

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

Atlas searches for a config file in this order:

1. `./atlas.config.json`
2. `./.atlas/config.json`
3. `~/.atlas/config.json`

The first file found is loaded. Values from the config file can be overridden by `.env` entries and environment variables.

## Invalid Configuration

If a required field is missing or invalid, Atlas exits immediately with a clear error listing every missing field. It will not start a backup with partial configuration -- this fail-fast behavior prevents silent failures where a run appears successful but is missing critical settings like the encryption passphrase.

## S3 Path Style

Atlas uses `forcePathStyle: true` when constructing the S3 client. This is **required** for MinIO and most self-hosted S3-compatible endpoints, which use path-style URLs (`http://host:9000/bucket-name`) rather than virtual-hosted-style (`http://bucket-name.host:9000`). If you are using AWS S3 directly, this setting is still compatible -- AWS S3 supports both styles.

::: danger Secure Your Configuration Files
The config file and `.env` file contain sensitive credentials: Azure client secrets, S3 access keys, and the encryption passphrase. On Linux, restrict file permissions immediately:

```bash
chmod 600 .env atlas.config.json
```

Atlas enforces this at runtime: on Unix systems, if a config file has group- or world-readable bits set (`mode & 0o077 !== 0`), a warning is logged recommending `chmod 600`. This is a warning rather than a hard error to avoid breaking existing deployments, but it should be addressed promptly.

Never commit these files to version control. The included `.gitignore` already excludes `.env`, but verify that your config file is also excluded. In multi-user environments, ensure only the service account running Atlas can read these files.
:::

## Replication Target Config

The `atlas replicate` command accepts `--target-config` and the `atlas rehydrate` command accepts `--source-config`, both pointing to a JSON file with S3 credentials for a secondary storage target:

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

The encryption passphrase is **not** included in this file. Atlas uses the shared encryption model -- the passphrase from the main configuration applies to all targets.

::: danger Secure Target Config Files
Target config files contain S3 credentials. Apply the same file permission restrictions as the main config file (`chmod 600`). Never commit them to version control.
:::
