import { logger } from '@/utils/logger';
import type { GraphConfig } from '@/utils/config';

/** The ATLAS_* environment variable that sets each Graph credential field. */
export const GRAPH_ENV_VARS: Readonly<Record<keyof GraphConfig, string>> = {
  tenant_id: 'ATLAS_TENANT_ID',
  client_id: 'ATLAS_CLIENT_ID',
  client_secret: 'ATLAS_CLIENT_SECRET',
};

const GRAPH_FIELDS = Object.keys(GRAPH_ENV_VARS) as (keyof GraphConfig)[];

/** Fields that decide which tenant and app a run signs in as; the secret only authenticates them. */
const IDENTITY_FIELDS: readonly (keyof GraphConfig)[] = ['tenant_id', 'client_id'];

/**
 * Lists the fields whose environment value replaces a different saved value. A field the saved
 * side leaves empty is not an override: the environment only fills it in.
 */
export function find_overridden_fields<K extends string>(
  saved: Partial<Record<K, string>>,
  env: Partial<Record<K, string>>,
  fields: readonly K[],
): K[] {
  return fields.filter(
    (field) =>
      env[field] !== undefined && saved[field] !== undefined && env[field] !== saved[field],
  );
}

/** Lists the selected profile's Graph fields that ATLAS_* variables replace with other values. */
export function find_graph_env_overrides(
  profile: Partial<GraphConfig> | undefined,
  env: Partial<GraphConfig>,
): (keyof GraphConfig)[] {
  if (profile === undefined) return [];
  return find_overridden_fields(profile, env, GRAPH_FIELDS);
}

/**
 * Throws when some Graph variables are unset and the set ones change the profile's tenant or
 * client ID: the run would sign in with one identity's ID and another's remaining credentials.
 */
export function assert_override_keeps_one_identity(
  profile_name: string,
  env: Partial<GraphConfig>,
  overridden: readonly (keyof GraphConfig)[],
): void {
  const unset = GRAPH_FIELDS.filter((field) => env[field] === undefined);
  const changes_identity = overridden.some((field) => IDENTITY_FIELDS.includes(field));
  if (unset.length === 0 || !changes_identity) return;
  throw new Error(
    `Environment variables change tenant profile "${profile_name}" ` +
      `(${env_var_list(overridden)}) while others stay unset (${env_var_list(unset)}), ` +
      'so this run would combine two identities. ' +
      'Set all three variables, or unset them to use the profile.',
  );
}

/** Warns on stderr that ATLAS_* variables replace values of the selected profile. Never logs a value. */
export function warn_graph_env_overrides(
  profile_name: string,
  overridden: readonly (keyof GraphConfig)[],
): void {
  if (overridden.length === 0) return;
  logger.warn(
    `Environment variables override tenant profile "${profile_name}" for this run: ` +
      `${env_var_list(overridden)}.`,
  );
}

function env_var_list(fields: readonly (keyof GraphConfig)[]): string {
  return fields.map((field) => GRAPH_ENV_VARS[field]).join(', ');
}
