---
description: Prompt a coding agent such as Claude Code or Codex to build a local Atlas test lab with MinIO and one verified test mailbox backup. Lab use only.
---

# AI quickstart

Paste the prompt below into a coding agent that runs shell commands on your machine, such as Claude Code, Codex, or Pi. It clones Atlas and builds a local test lab from what the repository ships: MinIO from `docker/docker-compose.yml`, the CLI built from source, the root `.env.example` as the configuration template, and one verified backup of a test mailbox.

The agent follows the `docs/` folder of its own clone, so the lab matches the code it builds. The lab is not for production: MinIO listens on localhost only, and the agent asks before it installs system packages, handles your Microsoft Entra credentials, or writes to Microsoft 365.

## Before you start

- A **non-production** Microsoft 365 tenant, or a test mailbox you can afford to read.
- A Microsoft Entra app registration with admin consent. See [Entra ID app registration](/azure-ad-setup). The agent asks for the tenant ID and client ID. You paste the client secret into `.env` yourself. The agent cannot create the registration.
- Git, Docker, OpenSSL, and Node.js 22.22.2 or later (the repository root's `engines` range; the published CLI alone needs 22.12). The agent checks all four and asks before installing anything.

## Prompt

```text
You are setting up an Atlas test lab on this machine. Atlas is an open-source
Microsoft 365 backup tool. Clone https://github.com/wisecom-oy/atlas and use
what the repository ships. The documentation in its docs/ folder is the
source of truth: before each step, read the page named for it and follow it.
Work step by step, run each command yourself, and show me the result of each
step before moving on.

Rules:
1. Never print, log, or echo secrets: the Entra client secret, S3 keys, MinIO
   root password, or the encryption passphrase. Refer to them by variable name.
2. Ask me before installing system packages (Git, Docker, Node.js, OpenSSL),
   enabling Corepack, or using sudo.
3. Ask me for the Entra tenant ID and client ID. Never invent them. Never ask
   for the client secret in chat: I paste it into .env myself, so it stays
   out of shell history and your output.
4. Use the repository's files as they are. Configure them through their .env
   files. Edit a tracked file only when the lab cannot work otherwise, tell me
   what you changed and why, and never commit or push.
5. Never run a restore command (anything with "restore") unless I explicitly
   ask in a later message. Restores write to Microsoft 365.
6. If a step fails, stop, show me the error, and propose a fix. Do not work
   around a failure by disabling checks.

Steps:
1. Check prerequisites: `git --version`, `node --version` (22.22.2 or later,
   the root package.json engines range), `docker compose version`, and
   `openssl version`. Report what is missing.
2. Clone the repository to ~/atlas-lab and work inside it from now on.
   Read docs/getting-started.md, docs/configuration.md,
   docs/self-hosting/storage.md, and docs/security.md.
3. Start MinIO with the repository's compose file (docs/self-hosting/storage.md):
   - Copy docker/.env.example to docker/.env and chmod 600 it.
   - Set MINIO_ROOT_USER=atlas-lab and MINIO_ROOT_PASSWORD to the output of
     `openssl rand -hex 32`. Compose refuses to start without a password.
   - Leave MINIO_BIND_ADDRESS=127.0.0.1 so MinIO is reachable from this
     machine only.
   - Run `docker compose up -d` in docker/ and wait until the container
     reports healthy.
   Use docker/docker-compose.yml, not docker-compose.dev.yml. The dev file
   is for the E2E suite, which this lab does not need.
4. Build and link the CLI from source with pnpm (the version is pinned in
   package.json's packageManager field; Corepack provides it):
   `pnpm install`, `pnpm run build`, then `pnpm run link-cli`.
   Confirm `atlas --version` runs. If linking fails, use
   `node packages/cli/dist/cli.mjs` in place of `atlas` from here on.
5. Copy .env.example to .env at the repository root and chmod 600 it
   (docs/configuration.md). Fill in ATLAS_TENANT_ID and ATLAS_CLIENT_ID
   (from me), ATLAS_S3_ENDPOINT=http://127.0.0.1:9000,
   ATLAS_S3_ACCESS_KEY and ATLAS_S3_SECRET_KEY matching docker/.env, and
   ATLAS_ENCRYPTION_PASSPHRASE generated with `openssl rand -base64 32`.
   Then ask me to replace the ATLAS_CLIENT_SECRET placeholder myself, and
   wait until I confirm.
   Tell me the passphrase lives in that file and that losing it makes every
   backup permanently unreadable (docs/security.md). Do not show it.
   Run every atlas command from the repository root, where .env is loaded.
6. Run `atlas config validate`, which checks the S3 connection. Then run
   `atlas tenants validate`, which requests a Graph token. Both must pass.
7. Ask me which test mailbox to back up. Then run
   `atlas outlook backup -m <mailbox>`. The first run creates the bucket
   atlas-<tenant-id> with Object Lock support.
8. Run `atlas storage-check` and confirm it reports Bucket class
   lock-capable and Status ready.
9. Run `atlas outlook list -m <mailbox>`, take the newest snapshot ID, and
   run `atlas outlook verify -m <mailbox> -s <snapshot-id>`. It must pass.
10. Finish with a short summary: what is running, every file you created or
    changed, the MinIO console URL (http://127.0.0.1:9001), and how to tear
    the lab down (`docker compose down -v` in docker/, then delete
    ~/atlas-lab).
```

## What the agent sets up

| Item | Location | Notes |
| --- | --- | --- |
| Repository | `~/atlas-lab` | Fresh clone. Tracked files stay unchanged unless the agent reports why |
| MinIO | `127.0.0.1:9000` (S3), `127.0.0.1:9001` (console) | `docker/docker-compose.yml`, pinned release, ports bound to loopback |
| MinIO credentials | `~/atlas-lab/docker/.env` | Random root password, mode 600 |
| Atlas CLI | `packages/cli/dist/cli.mjs`, linked as `atlas` | Built from the cloned source, so it matches the cloned docs |
| Atlas configuration | `~/atlas-lab/.env` | Mode 600. The CLI loads it from the working directory |
| Backup bucket | `atlas-<tenant-id>` in MinIO | Created lock-capable on the first backup |

## Security notes

::: warning The agent can read every secret it writes
That includes `.env`. Run it only where you accept that, and use a test app registration whose client secret you can revoke afterwards. Backup requires `Mail.ReadWrite`, so the secret can modify mailboxes in that tenant. See [Entra ID app registration](/azure-ad-setup#security-implications).
:::

The lab keeps the encryption passphrase in a plaintext file, which is acceptable only for a disposable lab. For real data, store the passphrase in a password manager or secrets vault as described in [Configuration](/configuration).

## See also

- [Getting started](/getting-started): the same setup by hand
- [Storage](/self-hosting/storage): MinIO for production
- [CLI reference](/reference/cli)
