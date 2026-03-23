import type { MailboxConnector } from '@/ports/mailbox/connector.port';

/** Fails fast if the mailbox does not exist in the tenant. */
export async function assert_mailbox_exists(
  connector: MailboxConnector,
  tenant_id: string,
  mailbox_id: string,
): Promise<void> {
  const exists = await connector.mailbox_exists(tenant_id, mailbox_id);
  if (!exists) {
    throw new Error(
      `Mailbox "${mailbox_id}" does not exist in the tenant. ` +
        `Verify the email address and try again.`,
    );
  }
}
