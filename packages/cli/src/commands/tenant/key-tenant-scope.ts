import { ConfigError } from '@wisecom/atlas-types';
import {
  find_profile,
  profile_names,
  read_secure_config,
  try_load_config_file,
} from '@wisecom/atlas-core';

/** The tenants a key command covers, and the known tenants a `--tenant` narrowing leaves out. */
export interface KeyTenantScope {
  readonly tenant_ids: readonly string[];
  readonly left_out: readonly string[];
}

/**
 * Every tenant ID that shares the configured passphrase: each profile's tenant, plus the tenant
 * this run resolved, which an `ATLAS_TENANT_ID` override may have added. Sorted and unique.
 *
 * The passphrase is a shared setting. Every profile's key is wrapped under it, so a passphrase
 * change that covers fewer than all of them strands the rest.
 */
export function list_tenants_sharing_passphrase(run_tenant_id: string): string[] {
  const file = try_load_config_file();
  const secure = read_secure_config();
  const tenant_ids = new Set<string>([run_tenant_id]);
  for (const name of profile_names(file, secure)) {
    const tenant_id = find_profile(name, file, secure)?.tenant_id;
    if (tenant_id !== undefined) tenant_ids.add(tenant_id);
  }
  return [...tenant_ids].sort();
}

/** Narrows the known tenants to `--tenant` when given, and names what the narrowing leaves out. */
export function resolve_key_tenant_scope(
  known: readonly string[],
  narrowed_to: string | undefined,
): KeyTenantScope {
  if (narrowed_to === undefined) return { tenant_ids: known, left_out: [] };
  return { tenant_ids: [narrowed_to], left_out: known.filter((t) => t !== narrowed_to) };
}

/**
 * Refuses a passphrase change that would leave known tenants under the old passphrase, unless
 * the operator said so with `--allow-partial`.
 *
 * @throws ConfigError naming every tenant the change would leave behind. Nothing was written.
 */
export function assert_passphrase_change_covers_all(
  scope: KeyTenantScope,
  allow_partial: boolean,
): void {
  if (scope.left_out.length === 0 || allow_partial) return;
  throw new ConfigError(
    `Refusing to change the passphrase of ${scope.tenant_ids.join(', ')} only. The passphrase ` +
      `is shared, and these tenants would stay wrapped under the old one: ` +
      `${scope.left_out.join(', ')}. Once the configured passphrase changes, every command for ` +
      `them fails until they are re-wrapped. Run without --tenant to re-wrap them all, or add ` +
      `--allow-partial to re-wrap only the named tenant. Nothing was changed.`,
  );
}
