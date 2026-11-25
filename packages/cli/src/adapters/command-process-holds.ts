import type { Container } from 'inversify';
import { release_throttle_process_hold } from '@/adapters/throttle-cooldown-release';

/** Every container the running command has sent, or may send, Graph requests through. */
const command_containers = new Set<Container>();

/**
 * Records a container the command sends Graph requests through and returns it, so its cooldowns stop
 * holding the process once the command ends. A cross-tenant restore composes a second container,
 * with its own coordinator, for the target tenant.
 */
export function track_command_container(container: Container): Container {
  command_containers.add(container);
  return container;
}

/**
 * Once the command has ended, successfully or not, lets the process exit with its exit code while a
 * throttle cooldown is still armed in any of its containers, instead of after it expires (#873).
 */
export function release_command_process_holds(): void {
  for (const container of command_containers) release_throttle_process_hold(container);
}
