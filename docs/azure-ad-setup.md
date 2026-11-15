---
description: Register a Microsoft Entra ID app for Atlas with Microsoft Graph application permissions and a client secret for unattended Microsoft 365 backups.
---

# Microsoft Entra ID setup

Atlas signs in to Microsoft 365 as an application, with no user involved. You create that application once as an app registration in Microsoft Entra ID. Its permissions decide what Atlas can read and restore, and its client secret is the credential Atlas uses.

Technically, Atlas uses the OAuth2 client credentials flow (`@azure/identity` `ClientSecretCredential`) against Microsoft Graph.

## Register the application

1. In the Microsoft Entra admin center, register a new application.
2. Under **API permissions**, add the **Application** permissions below for the workloads you back up. Do not use Delegated permissions.
3. Click **Grant admin consent for [your tenant]**. Permissions do not take effect until an administrator grants consent.
4. Under **Certificates & secrets**, create a client secret and copy its **Value**.
5. Give Atlas the tenant ID, the application (client) ID, and the secret value. See [Configuration](/configuration#tenant-profiles).

## Outlook mail permissions

| Permission             | Used for                                                                  | Needed by                             |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------- |
| `Mail.Read`            | Reading mailbox contents                                                  | Backup, list, read, save, verify      |
| `Mail.ReadWrite`       | Incremental sync and full message fetch; creating messages and folders on restore | Backup and restore            |
| `User.Read.All`        | Listing users and looking up addresses as object IDs                      | User discovery                        |
| `MailboxSettings.Read` | Reading mailbox metadata and folders, and detecting shared mailboxes      | Folder listing, mailbox discovery     |

::: warning Mail.ReadWrite is required for backup
Backups need `Mail.ReadWrite` as well as `Mail.Read`, because incremental sync and full message fetch use it. Anyone holding the client secret can therefore modify mailboxes. Protect the secret as carefully as the encryption passphrase and rotate it on a schedule (see [Client secret rotation](#client-secret-rotation)).
:::

`atlas outlook mailboxes` also shows mailbox sizes when `Reports.Read.All` is granted, and omits the Size column otherwise. This permission reads every usage report in the tenant, not only mailbox sizes, so grant it only if you need capacity planning.

## OneDrive, SharePoint, Contacts, and Calendar permissions

Grant these on the same app registration. The write permission in the last column is needed only for restore.

| Workload   | Permissions for backup             | Add for restore       |
| ---------- | ---------------------------------- | --------------------- |
| OneDrive   | `Files.Read.All`, `Sites.Read.All`, `User.Read.All` | `Files.ReadWrite.All` |
| SharePoint | `Sites.Read.All`, `Files.Read.All` | `Sites.ReadWrite.All` |
| Contacts   | `Contacts.Read`                    | `Contacts.ReadWrite`  |
| Calendar   | `Calendars.Read`                   | `Calendars.ReadWrite` |

The commands that use them are in [OneDrive backup](./onedrive-backup.md), [SharePoint backup](./sharepoint-backup.md), [Contacts backup](./contacts-backup.md), and [Calendar backup](./calendar-backup.md).

## Teams application permissions

Teams backup reads team structure, membership, and channel messages. Grant all eight **Application** permissions on the same app registration:

| Permission                | Used for                                                    |
| ------------------------- | ----------------------------------------------------------- |
| `Team.ReadBasic.All`      | List teams and read team settings                           |
| `TeamSettings.Read.All`   | Read team settings                                          |
| `TeamMember.Read.All`     | List team members                                           |
| `Channel.ReadBasic.All`   | List channels                                               |
| `ChannelMember.Read.All`  | List channel members                                        |
| `ChannelMessage.Read.All` | Read channel messages and replies. Protected API, see below |
| `TeamsTab.Read.All`       | Read channel tabs                                           |
| `Files.Read.All`          | Find each channel's files folder                            |

`Sites.Read.All` can stand in for `Files.Read.All` when finding the files folder. Without either, Microsoft Graph returns `403` for that call and Atlas records the channel's files folder as unavailable.

::: warning ChannelMessage.Read.All may need Microsoft approval
`ChannelMessage.Read.All` is a protected Microsoft Graph API. Microsoft may require approval of the app before Graph returns channel messages, even after admin consent. Request access at [https://aka.ms/teamsgraph/requestaccess](https://aka.ms/teamsgraph/requestaccess) before you schedule Teams backups.
:::

This permission exposes the text of every channel message in the tenant, including private channels. Treat it as the most sensitive permission on the app. See [Teams backup](./teams-backup.md) for what is stored.

## Security implications

With no user in the loop, the client secret carries the full risk:

- **Tenant-wide access.** The application can read every mailbox and drive in the tenant. The API does not scope access per user or per mailbox.
- **No interactive checks.** Sign-in uses only the client ID and secret, so no MFA prompt applies.
- **The secret is the only barrier.** Anyone holding it has the same access as Atlas, within the granted permissions.

Keep the secret in a secrets manager such as Azure Key Vault or HashiCorp Vault, or in the CLI's encrypted store (`atlas tenants add`), not in plaintext files. Review Microsoft Entra sign-in logs for unexpected application sign-ins, and rotate the secret regularly.

## Client secret rotation

Rotate the client secret at least every 90 days in production.

1. In **Certificates & secrets**, add a new client secret.
2. Copy the secret **Value** immediately. The portal shows it once. The **Secret ID** is not the secret.
3. Update Atlas. Either set `ATLAS_CLIENT_SECRET`, or add the profile again with the new value read from stdin, which keeps it out of shell history:

   ```bash
   pbpaste | atlas tenants add <name> --tenant-id <tenant-id> --client-id <client-id> --client-secret - --replace
   ```

4. Run `atlas tenants validate <name>` to confirm sign-in works, then delete the old secret in **Certificates & secrets**.

An expired or mistyped secret fails with `AADSTS7000215`. See [Troubleshooting](/troubleshooting#aadsts-error-codes).

## Certificates

Microsoft Entra ID also supports certificate credentials, which are harder to exfiltrate than a string secret and can live in an HSM. Atlas supports client secrets only, so a certificate on the app registration does not replace the secret in Atlas configuration.

## See also

- [Configuration](/configuration)
- [Security model](/security)
