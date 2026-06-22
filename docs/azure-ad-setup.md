# Azure AD Setup

Atlas authenticates with Microsoft Graph using the **OAuth2 Client Credentials flow** via `@azure/identity` `ClientSecretCredential`. This flow authenticates the application itself (not a user), which has specific security implications covered below.

## Register an Application

In the Azure Portal, register an application with the following **Application** permissions (not Delegated):

| Permission             | Why                                                     | Required For                     |
| ---------------------- | ------------------------------------------------------- | -------------------------------- |
| `Mail.Read`            | Read mailbox contents via Graph API                     | Backup, list, read, save, verify |
| `Mail.ReadWrite`       | Restore messages and create folders in target mailboxes | Restore only                     |
| `User.Read.All`        | Enumerate users and resolve mailbox IDs                 | User discovery                   |
| `MailboxSettings.Read` | Read mailbox metadata and folder structure              | Folder enumeration               |

### Principle of Least Privilege

::: tip Start with Read-Only
If you only need backups (no restore), grant only `Mail.Read` instead of `Mail.ReadWrite`. This limits the application's ability to modify mailbox contents, reducing the blast radius if the client secret is compromised. Add `Mail.ReadWrite` later only when restore functionality is needed.
:::

## Grant Admin Consent

After adding permissions, click **Grant admin consent for [your tenant]** in the API Permissions blade.

## Security Implications of Client Credentials

The Client Credentials flow means Atlas authenticates **as the application itself**, not on behalf of any specific user. This has important consequences:

- **Tenant-wide access** — the application has permission to read (and potentially write) **every mailbox** in the tenant. There is no per-user consent or per-mailbox scoping at the API level.
- **No user interaction** — authentication is fully automated using a client ID and secret. No MFA, no user prompt, no interactive login.
- **Secret is the only barrier** — anyone who obtains the client secret can access all mailboxes in the tenant with whatever permissions are granted.

This makes the client secret one of the most sensitive credentials in your Atlas deployment. Protect it accordingly:

- Store it in a secrets manager (Azure Key Vault, HashiCorp Vault, etc.), not in plaintext files on shared drives.
- Rotate the secret regularly (every 90 days minimum for production environments).
- Monitor Azure AD sign-in logs for unexpected application authentications.

### Certificate-Based Authentication

For higher security, Azure AD supports **certificate-based authentication** as an alternative to client secrets. Certificates are harder to exfiltrate than string secrets and can be stored in hardware security modules (HSMs). Atlas currently uses client secrets, but Azure AD allows both methods for the same application registration -- you can create a certificate credential alongside or instead of a secret.

## Optional: Mailbox Size Reporting

The `atlas outlook mailboxes` command can show mailbox sizes if the `Reports.Read.All` permission is granted. If the permission is not present, the Size column is simply omitted without error.

| Permission         | Why                                        |
| ------------------ | ------------------------------------------ |
| `Reports.Read.All` | Access mailbox usage reports for size data |

This permission grants read access to all usage reports in the tenant, not just mailbox sizes. Grant it only if you need the sizing information for capacity planning.
