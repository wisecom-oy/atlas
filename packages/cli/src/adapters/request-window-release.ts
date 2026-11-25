import type { Container } from 'inversify';
import { RateLimitedGraphConnector } from '@wisecom/atlas-m365-graph';
import { MAILBOX_CONNECTOR_TOKEN } from '@wisecom/atlas-types';
import type { MailboxConnector } from '@wisecom/atlas-types/ports/outlook/connector.port';

/**
 * Hands `record` every rate-limited mailbox connector `container` builds, as it is built, so the
 * command can release its request windows once it ends without building one it never used.
 *
 * A caller parked on a mailbox's request window holds the process open (issue #859). After a
 * failed command that hold would keep the process running until the window refills, for up to 10
 * minutes after the error was printed.
 */
export function track_rate_limited_mailbox_connectors(
  container: Container,
  record: (connector: RateLimitedGraphConnector) => void,
): void {
  container.onActivation<MailboxConnector>(MAILBOX_CONNECTOR_TOKEN, (_context, connector) => {
    if (connector instanceof RateLimitedGraphConnector) record(connector);
    return connector;
  });
}
