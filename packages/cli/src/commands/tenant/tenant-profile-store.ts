import type { StoredConfig, TenantProfile } from '@wisecom/atlas-core';
import {
  GRAPH_ENV_VARS,
  logger,
  normalize_stored_config,
  read_env_overrides,
  read_secure_config,
  update_secure_config,
} from '@wisecom/atlas-core';

/** Reads the encrypted store with legacy top-level Graph fields moved into `tenants.default`. */
export function read_store(): StoredConfig {
  return normalize_stored_config(read_secure_config());
}

/** Rewrites the store under its lock; `mutate` sees it normalized and may throw to abort. */
export function update_store(mutate: (stored: StoredConfig) => StoredConfig): StoredConfig {
  return update_secure_config((current) => mutate(normalize_stored_config(current)));
}

/**
 * Builds the store to persist: everything from `stored` except the profile map and active
 * profile, which are replaced. Empty fields are omitted so the file stays minimal.
 */
export function build_store(
  stored: StoredConfig,
  tenants: Record<string, Partial<TenantProfile>>,
  active_tenant: string | undefined,
): StoredConfig {
  const { tenants: _tenants, active_tenant: _active, ...shared } = stored;
  return {
    ...shared,
    ...(Object.keys(tenants).length > 0 ? { tenants } : {}),
    ...(active_tenant !== undefined ? { active_tenant } : {}),
  };
}

/** Graph credentials supplied through ATLAS_* environment variables. */
export function read_graph_env_overrides(): Partial<TenantProfile> {
  const env = read_env_overrides();
  return {
    ...(env.tenant_id !== undefined ? { tenant_id: env.tenant_id } : {}),
    ...(env.client_id !== undefined ? { client_id: env.client_id } : {}),
    ...(env.client_secret !== undefined ? { client_secret: env.client_secret } : {}),
  };
}

/** Warns when ATLAS_* Graph variables override the selected profile. */
export function warn_graph_env_overrides(): void {
  const present = Object.values(GRAPH_ENV_VARS).filter((name) => process.env[name]);
  if (present.length > 0) {
    logger.warn(
      `Environment ${present.join(', ')} override the selected profile's credentials for this run.`,
    );
  }
}
