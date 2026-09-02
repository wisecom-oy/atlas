import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';

/**
 * Graph failures that an operator has to act on rather than retry: a missing application
 * permission and an unlicensed mailbox. Both carry the remediation steps in the message and a
 * stable class and code for callers (issue #40).
 */
/**
 * Detects 403 ErrorAccessDenied from Graph and rethrows with
 * actionable guidance about which API permissions to grant.
 */
export function rethrow_if_access_denied(err: unknown): void {
  const graph_err = err as Record<string, unknown>;
  if (graph_err.statusCode !== 403) return;

  const required = [
    'Mail.Read              -- read mailbox messages',
    'Mail.ReadWrite         -- delta sync and full message fetch',
    'User.Read.All          -- list tenant users / mailboxes',
    'MailboxSettings.Read   -- enumerate mail folders',
  ];

  const hint =
    `Microsoft Graph returned 403 Forbidden (ErrorAccessDenied).\n` +
    `The app registration needs these Application permissions with admin consent:\n\n` +
    required.map((p) => `  - ${p}`).join('\n') +
    `\n\n` +
    `Grant them in Azure Portal > App registrations > API permissions > ` +
    `Add a permission > Microsoft Graph > Application permissions, ` +
    `then click "Grant admin consent".`;

  throw new AuthError(hint, { cause: err });
}

/**
 * Detects MailboxNotEnabledForRESTAPI from Graph and rethrows with
 * actionable guidance about reassigning an Exchange Online license.
 */
export function rethrow_if_mailbox_not_licensed(err: unknown): void {
  const graph_err = err as Record<string, unknown>;
  const code = String(graph_err.code ?? '');
  const message = err instanceof Error ? err.message : String(err);

  if (code === 'MailboxNotEnabledForRESTAPI' || message.includes('MailboxNotEnabledForRESTAPI')) {
    throw new MailboxNotLicensedError(
      `The mailbox is not licensed for API access (MailboxNotEnabledForRESTAPI).\n` +
        `This typically happens when the user's Exchange Online license has been removed.\n` +
        `The mailbox data is retained for 30 days after license removal, but cannot be\n` +
        `accessed via the Graph API until a license is reassigned.\n\n` +
        `To back up or restore this mailbox:\n` +
        `  1. Reassign an Exchange Online license to the user in Microsoft 365 admin center\n` +
        `  2. Wait a few minutes for the mailbox to reconnect\n` +
        `  3. Run the operation again\n` +
        `  4. Remove the license after the operation completes (if desired)`,
      { cause: err },
    );
  }
}
