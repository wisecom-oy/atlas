# Azure AD Setup

Atlas authenticates with Microsoft Graph using the **OAuth2 Client Credentials flow** via `@azure/identity` `ClientSecretCredential`. This authenticates the application itself, not a user, which has security implications covered below.

## Register an Application

In the Azure Portal, register an application with the following **Application** permissions (not Delegated):

| Permission             | Why                                                                                  | Required For                          |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------------------------- |
| `Mail.Read`            | Read mailbox contents via Graph API                                                  | Backup, list, read, save, verify      |
| `Mail.ReadWrite`       | Restore messages and create folders in target mailboxes                              | Restore only                          |
| `User.Read.All`        | Enumerate users and resolve mailbox IDs                                              | User discovery                        |
| `MailboxSettings.Read` | Read mailbox metadata and folder structure; shared-mailbox detection (`userPurpose`) | Folder enumeration, mailbox discovery |

::: tip Start with Read-Only
If you only need backups (no restore), grant `Mail.Read` instead of `Mail.ReadWrite`. This limits the application's ability to modify mailbox contents, reducing the blast radius if the client secret is compromised. Add `Mail.ReadWrite` later, only when restore functionality is needed.
:::

## Grant Admin Consent

After adding permissions, click **Grant admin consent for [your tenant]** in the API Permissions blade.

## Optional: Mailbox Size Reporting

`atlas outlook mailboxes` can show mailbox sizes if `Reports.Read.All` is granted. Without it, the Size column is omitted without error.

| Permission         | Why                                        |
| ------------------ | ------------------------------------------ |
| `Reports.Read.All` | Access mailbox usage reports for size data |

This permission grants read access to all usage reports in the tenant, not just mailbox sizes. Grant it only if you need the sizing information for capacity planning.

## Security Implications of Client Credentials

The Client Credentials flow means Atlas authenticates **as the application itself**, not on behalf of any specific user:

- **Tenant-wide access**: the application can read (and potentially write) **every mailbox** in the tenant. There is no per-user consent or per-mailbox scoping at the API level.
- **No user interaction**: authentication is fully automated using a client ID and secret. No MFA, no user prompt, no interactive login.
- **The secret is the only barrier**: anyone who obtains the client secret can access all mailboxes in the tenant with whatever permissions are granted.

That makes the client secret one of the most sensitive credentials in your Atlas deployment. Protect it accordingly:

- Store it in a secrets manager (Azure Key Vault, HashiCorp Vault, etc.), not in plaintext files on shared drives.
- Monitor Azure AD sign-in logs for unexpected application authentications.
- Rotate it regularly.

## Client Secret Rotation

Rotate the client secret every 90 days at minimum for production environments.

1. In **Certificates & secrets** on the app registration, add a new client secret.
2. Copy the secret **Value** immediately. The portal shows it only once, and the Secret ID is not the secret.
3. Update Atlas with the new value, either `ATLAS_CLIENT_SECRET` or `atlas config client.secret` (see [Configuration](/configuration)).
4. Confirm authentication works, then delete the old secret in **Certificates & secrets**.

An expired or mistyped secret surfaces as `AADSTS7000215`. See [Troubleshooting](/troubleshooting#aadsts-error-codes).

## Certificate-Based Authentication

Azure AD supports **certificate-based authentication** as an alternative to client secrets. Certificates are harder to exfiltrate than string secrets and can be stored in hardware security modules (HSMs). Atlas currently uses client secrets. Azure AD allows both methods on the same application registration, so you can create a certificate credential alongside or instead of a secret.
