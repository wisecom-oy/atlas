import { Container } from 'inversify';
import {
  ATLAS_CONFIG_TOKEN,
  GRAPH_IDENTITY_RESOLVER_TOKEN,
  TENANT_KEYS,
  type AtlasConfig,
  type GraphConfig,
} from '@wisecom/atlas-core';
import { bind_graph_client } from '@wisecom/atlas-m365-graph';
import {
  ConfigError,
  USER_IDENTITY_RESOLVER_TOKEN,
  type AtlasTenant,
  type AtlasTenantConfig,
  type TargetTenantOption,
  type UserIdentityResolver,
} from '@wisecom/atlas-types';
import { create_container_from_config } from '@/container';
import { create_disposer } from '@/instance-disposal';
import { validate_graph_token } from '@/instance-validation';

/** Public option name for each Graph field, in the order errors report them. */
const PUBLIC_FIELDS = {
  tenant_id: 'tenantId',
  client_id: 'clientId',
  client_secret: 'clientSecret',
};

/**
 * A tenant a restore can write into. The credentials sit in a private field: `JSON.stringify`,
 * `console.log` and object spread never reach the secret, and only this module can read it back.
 */
class SdkTenant implements AtlasTenant {
  readonly #graph: GraphConfig;

  constructor(graph: GraphConfig) {
    this.#graph = graph;
  }

  /** The Microsoft Entra tenant this handle writes into. */
  get tenantId(): string {
    return this.#graph.tenant_id;
  }

  /** The app registration this handle signs in as. */
  get clientId(): string {
    return this.#graph.client_id;
  }

  /** Requests a Graph token with these credentials, then releases the client built for it. */
  async validate(): Promise<void> {
    const container = new Container();
    bind_graph_client(container, this.#graph);
    try {
      await validate_graph_token(container);
    } finally {
      await create_disposer(container)();
    }
  }

  /** Reads a handle's credentials, refusing anything `createTenant` did not return. */
  static credentials_of(tenant: unknown): GraphConfig {
    if (typeof tenant !== 'object' || tenant === null || !(#graph in tenant)) {
      throw new ConfigError('targetTenant must be a tenant returned by createTenant().');
    }
    return tenant.#graph;
  }
}

/** Creates a tenant handle to pass as a restore's `targetTenant`; checks formats without I/O. */
export function create_tenant(config: AtlasTenantConfig): AtlasTenant {
  if (!config || typeof config !== 'object') {
    throw new ConfigError('Tenant configuration must be an object.');
  }
  const graph: GraphConfig = {
    tenant_id: config.tenantId,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  };
  for (const spec of TENANT_KEYS) {
    const field = spec.field as keyof GraphConfig;
    const value: unknown = graph[field];
    const problem = typeof value === 'string' ? spec.validate(value) : 'must be a string';
    if (problem !== null) throw new ConfigError(`${PUBLIC_FIELDS[field]} ${problem}.`);
  }
  return new SdkTenant(graph);
}

/** Where a restore writes: the container doing the Graph writes and the resolver for its target. */
export interface RestoreSide {
  readonly container: Container;
  readonly target_identity: UserIdentityResolver;
}

/**
 * Runs one restore on the instance, or through `target_tenant` when the caller set one. A
 * cross-tenant restore gets a container with the instance's storage and passphrase, which read
 * and decrypt the backup, and the tenant's Graph credentials, which do the writes. Its target is
 * resolved through that tenant's Graph alone, never the instance's identity registry.
 *
 * ponytail: one container per cross-tenant restore; cache per tenant handle if restores get small
 * and frequent enough for client setup to show.
 */
export async function with_restore_side<T>(
  container: Container,
  target_tenant: TargetTenantOption['targetTenant'],
  target: string | undefined,
  method: string,
  run: (side: RestoreSide) => Promise<T>,
): Promise<T> {
  if (target_tenant === undefined) {
    const identity = container.get<UserIdentityResolver>(USER_IDENTITY_RESOLVER_TOKEN);
    return run({ container, target_identity: identity });
  }
  if (target === undefined || target === '') {
    throw new TypeError(
      `${method} with targetTenant needs an explicit target: object IDs differ between tenants, ` +
        'so the destination is never guessed from the source.',
    );
  }
  const graph = SdkTenant.credentials_of(target_tenant);
  const target_container = create_container_from_config({
    ...container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN),
    ...graph,
  });
  try {
    const identity = target_container.get<UserIdentityResolver>(GRAPH_IDENTITY_RESOLVER_TOKEN);
    return await run({ container: target_container, target_identity: identity });
  } finally {
    await create_disposer(target_container)();
  }
}

/** Splits `targetTenant` off restore options, so the services never receive the handle. */
export function split_target_tenant<T extends TargetTenantOption>(
  options: T | undefined,
): [TargetTenantOption['targetTenant'], Omit<T, 'targetTenant'> | undefined] {
  if (options === undefined) return [undefined, undefined];
  const { targetTenant: target_tenant, ...rest } = options;
  return [target_tenant, rest];
}
