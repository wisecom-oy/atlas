# Entra ID app registration

Atlas authenticates to Microsoft Graph with the OAuth2 client credentials flow, using `@azure/identity` `ClientSecretCredential`. The application signs in as itself, with no user involved, so the app registration's permissions and secret define what Atlas can reach.

## Register the application

In the Microsoft Entra admin center, register an application, then add these **Application** permissions under **API permissions**. Do not use Delegated permissions.

| Permission             | Used for                                                                 | Needed by                             |
| ---------------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `Mail.Read`            | Reading mailbox contents                                                 | Backup, list, read, save, verify      |
| `Mail.ReadWrite`       | Delta sync and full message fetch; creating messages and folders on restore | Backup and restore                 |
| `User.Read.All`        | Enumerating users and resolving addresses to object IDs                  | User discovery                        |
| `MailboxSettings.Read` | Reading mailbox metadata and folders, and detecting shared mailboxes     | Folder enumeration, mailbox discovery |

::: warning Mail.ReadWrite is required for backup
Backups need `Mail.ReadWrite` as well as `Mail.Read`, because delta sync and full message fetch use it. Anyone holding the client secret can therefore modify mailboxes. Store the secret as carefully as the encryption passphrase and rotate it on a schedule (see [Client secret rotation](#client-secret-rotation)).
:::

Then click **Grant admin consent for [your tenant]**. The permissions do not take effect until an administrator grants consent.

### Optional: mailbox size reporting

`atlas outlook mailboxes` shows mailbox sizes when `Reports.Read.All` is granted. Without it, the Size column is omitted. The permission reads every usage report in the tenant, not only mailbox sizes, so grant it only for capacity planning.

## OneDrive and SharePoint permissions

OneDrive and SharePoint backups use their own permission sets, granted on the same app registration:

| Workload                 | Permissions                                                       | Notes                                              |
| ------------------------ | ----------------------------------------------------------------- | -------------------------------------------------- |
| OneDrive                 | `Files.Read.All`, `User.Read.All`                                 | `Files.ReadWrite.All` is needed for restore only   |
| SharePoint               | `Sites.Read.All`, `Files.Read.All`                                | `Sites.ReadWrite.All` is needed for restore only   |

See [OneDrive backup](./onedrive-backup.md) and [SharePoint backup](./sharepoint-backup.md) for the commands that use them.

## Security implications

The client credentials flow has no user in the loop, so the secret carries the full risk:

- **Tenant-wide access.** The application can read every mailbox and drive in the tenant. The API does not scope access per user or per mailbox.
- **No interactive checks.** Sign-in uses only the client ID and secret. No user signs in, so no MFA prompt applies to the request.
- **The secret is the only barrier.** Anyone holding it has the same access as Atlas, within the granted permissions.

Protect the secret accordingly. Keep it in a secrets manager such as Azure Key Vault or HashiCorp Vault, or in the encrypted store with `atlas config`, rather than in plaintext files. Review Microsoft Entra sign-in logs for unexpected application sign-ins, and rotate the secret regularly.

## Client secret rotation

Rotate the client secret at least every 90 days in production.

1. In **Certificates & secrets**, add a new client secret.
2. Copy the secret **Value** immediately. The portal shows it once. The **Secret ID** is not the secret.
3. Update Atlas: set `ATLAS_CLIENT_SECRET`, or pipe the value to `atlas config set client.secret -`, which reads from stdin and keeps it out of shell history. See [Configuration](/configuration).
4. Run `atlas config validate` to confirm authentication works, then delete the old secret in **Certificates & secrets**.

An expired or mistyped secret fails with `AADSTS7000215`. See [troubleshooting](/troubleshooting#aadsts-error-codes).

## Certificates

Microsoft Entra ID also supports certificate credentials, which are harder to exfiltrate than a string secret and can live in an HSM. Atlas uses client secrets only, so a certificate on the app registration does not replace the secret in Atlas configuration.

See also: [Configuration](/configuration), [Security model](/security).
