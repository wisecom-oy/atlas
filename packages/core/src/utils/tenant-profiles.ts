import type { AtlasConfig, GraphConfig } from '@/utils/config';

/** One named set of Microsoft Graph credentials. */
export type TenantProfile = GraphConfig;

/**
 * Config as a file or the encrypted store holds it: shared S3 and encryption settings plus
 * named tenant profiles. Top-level `tenant_id`, `client_id` and `client_secret` are the layout
 * before profiles existed and are read as the `default` profile.
 */
export type StoredConfig = Partial<AtlasConfig> & {
  readonly tenants?: Readonly<Record<string, Partial<TenantProfile>>>;
  readonly active_tenant?: string;
};

/** The profile legacy top-level Graph fields belong to, and the one used when none is selected. */
export const DEFAULT_PROFILE = 'default';

/** Lowercase letters, digits and dashes, so a name is safe in a flag, a file and a log line. */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const GRAPH_FIELDS = ['tenant_id', 'client_id', 'client_secret'] as const;

/** Lists a source's profiles, presenting legacy top-level Graph fields as the default profile. */
export function list_profiles(source: StoredConfig): Record<string, Partial<TenantProfile>> {
  const profiles: Record<string, Partial<TenantProfile>> = { ...read_tenants_map(source) };
  const legacy = pick_graph_fields(source);
  if (Object.keys(legacy).length > 0) {
    profiles[DEFAULT_PROFILE] = { ...legacy, ...profiles[DEFAULT_PROFILE] };
  }
  return profiles;
}

/** Returns a source's settings shared by every profile: everything but Graph credentials. */
export function shared_settings(source: StoredConfig): Partial<AtlasConfig> {
  const {
    tenants: _tenants,
    active_tenant: _active,
    tenant_id: _tenant_id,
    client_id: _client_id,
    client_secret: _client_secret,
    ...shared
  } = source;
  return shared;
}

/**
 * Rewrites legacy top-level Graph fields into `tenants.default`, the layout every write
 * persists, so a store touched by `atlas tenants` never carries both.
 */
export function normalize_stored_config(source: StoredConfig): StoredConfig {
  const tenants = list_profiles(source);
  return {
    ...shared_settings(source),
    ...(Object.keys(tenants).length > 0 ? { tenants } : {}),
    ...(source.active_tenant !== undefined ? { active_tenant: source.active_tenant } : {}),
  };
}

/**
 * Names the profile a run uses: an explicit choice (the `--profile` flag), then
 * `ATLAS_PROFILE`, then the stored active profile, then `default`.
 */
export function select_profile_name(
  explicit: string | undefined,
  file: StoredConfig,
  secure: StoredConfig,
): string {
  const from_env = process.env['ATLAS_PROFILE'] || undefined;
  return explicit ?? from_env ?? secure.active_tenant ?? file.active_tenant ?? DEFAULT_PROFILE;
}

/**
 * Merges one profile across the file and the store, the store winning field by field.
 * Returns undefined when neither defines it.
 */
export function find_profile(
  name: string,
  file: StoredConfig,
  secure: StoredConfig,
): Partial<TenantProfile> | undefined {
  const from_file = list_profiles(file)[name];
  const from_secure = list_profiles(secure)[name];
  if (from_file === undefined && from_secure === undefined) return undefined;
  return { ...from_file, ...from_secure };
}

/** Lists every profile name defined across the file and the store, sorted. */
export function profile_names(file: StoredConfig, secure: StoredConfig): string[] {
  const names = new Set([
    ...Object.keys(list_profiles(file)),
    ...Object.keys(list_profiles(secure)),
  ]);
  return [...names].sort();
}

/** Describes an unknown profile, naming the ones that exist. */
export function unknown_profile_message(name: string, known: readonly string[]): string {
  const listed =
    known.length > 0 ? `Known profiles: ${known.join(', ')}.` : 'No profiles exist yet.';
  return `Unknown tenant profile "${name}". ${listed} Add one with "atlas tenants add".`;
}

function read_tenants_map(source: StoredConfig): Record<string, Partial<TenantProfile>> {
  const tenants: unknown = source.tenants;
  if (tenants === undefined) return {};
  if (typeof tenants !== 'object' || tenants === null || Array.isArray(tenants)) {
    throw new Error(
      'Config field "tenants" must be an object mapping profile names to credentials',
    );
  }
  const profiles: Record<string, Partial<TenantProfile>> = {};
  for (const [name, value] of Object.entries(tenants)) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`Tenant profile "${name}" must be an object`);
    }
    profiles[name] = pick_graph_fields(value as Record<string, unknown>);
  }
  return profiles;
}

/** Keeps only string Graph fields, so a stray key in a hand-edited file never becomes config. */
function pick_graph_fields(source: Readonly<Record<string, unknown>>): Partial<TenantProfile> {
  const picked: Partial<Record<(typeof GRAPH_FIELDS)[number], string>> = {};
  for (const field of GRAPH_FIELDS) {
    const value = source[field];
    if (typeof value === 'string' && value !== '') picked[field] = value;
  }
  return picked;
}
