/**
 * Builds the real Teams DI container against the fake server. Binds only what the Teams backup
 * path resolves: the Graph client, a per-process throttle coordinator, the tenant context
 * factory, the owner lease over that store, then `bind_teams`. The pacer is rebound with defaults
 * scaled by the time scale.
 */
import 'reflect-metadata';
import { Container } from 'inversify';
import { bind_teams, DEFAULT_TEAMS_PACING_RATES, TeamsRequestPacer } from '@wisecom/atlas-teams';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import {
  OWNER_LEASE_TOKEN,
  THROTTLE_COORDINATOR_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { StorageOwnerLeases } from '@wisecom/atlas-core/services/lease/storage-owner-leases';

/**
 * Pacing rates from the real defaults (GRAPH_SERVICE_LIMITS x headroom), multiplied by `time_scale`
 * so one simulated second of the Graph budget fits into 1/k real seconds.
 * @param {number} time_scale
 */
export function scaled_pacing_rates(time_scale) {
  return Object.fromEntries(
    Object.entries(DEFAULT_TEAMS_PACING_RATES).map(([name, rps]) => [name, rps * time_scale]),
  );
}

/**
 * @param {{client: object, tenant_factory: object, time_scale: number}} options
 * @returns {Container} container resolving TEAMS_BACKUP_USE_CASE_TOKEN and friends
 */
export function create_teams_container({ client, tenant_factory, time_scale }) {
  const container = new Container();
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(client);
  container.bind(THROTTLE_COORDINATOR_TOKEN).toConstantValue(new InProcessThrottleCoordinator());
  container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(tenant_factory);
  // The same lease the CLI and SDK bind (core container.ts), on the rig's own store.
  container.bind(OWNER_LEASE_TOKEN).toConstantValue(new StorageOwnerLeases());
  bind_teams(container);
  // bind_teams binds the pacer as a singleton; rebinding before first resolution swaps in scaled rates.
  container
    .rebind(TeamsRequestPacer)
    .toConstantValue(new TeamsRequestPacer(scaled_pacing_rates(time_scale)));
  return container;
}
