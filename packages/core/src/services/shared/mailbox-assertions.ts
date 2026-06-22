import type { MailboxConnector } from '@atlas/types';

/** Fails fast if the mailbox does not exist in the tenant. */
export async function assert_mailbox_exists(
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
): Promise<void> {
  const exists = await connector.mailbox_exists(tenant_id, owner_id);
  if (!exists) {
    throw new Error(
      `Mailbox "${owner_id}" does not exist in the tenant. ` +
        `Verify the email address and try again.`,
    );
  }
}
