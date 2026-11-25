import type { Container } from 'inversify';
import type { RateLimitedGraphConnector } from '@wisecom/atlas-m365-graph';
import { release_throttle_process_hold } from '@/adapters/throttle-cooldown-release';
import { track_rate_limited_mailbox_connectors } from '@/adapters/request-window-release';

/** Every container the running command has sent, or may send, Graph requests through. */
const command_containers = new Set<Container>();

/** Every rate-limited mailbox connector those containers have built. */
const mailbox_connectors = new Set<RateLimitedGraphConnector>();

/**
 * Records a container the command sends Graph requests through and returns it, so its cooldowns and
 * request windows stop holding the process once the command ends. A cross-tenant restore composes a
 * second container, with its own coordinator, for the target tenant.
 */
export function track_command_container(container: Container): Container {
  command_containers.add(container);
  track_rate_limited_mailbox_connectors(container, (connector) => {
    mailbox_connectors.add(connector);
  });
  return container;
}

/**
 * Once the command has ended, successfully or not, lets the process exit with its exit code while a
 * throttle cooldown is still armed in any of its containers (#873), or a request is still parked on
 * a mailbox's request window (#859), instead of after they expire.
 */
export function release_command_process_holds(): void {
  for (const container of command_containers) release_throttle_process_hold(container);
  for (const connector of mailbox_connectors) connector.release_process_hold();
}
