import type { StoredConfig } from '@wisecom/atlas-core';
import {
  find_profile,
  list_profiles,
  logger,
  mask_secret,
  profile_names,
  select_profile_name,
  try_load_config_file,
  unknown_profile_message,
} from '@wisecom/atlas-core';
import {
  build_store,
  read_store,
  update_store,
  warn_graph_env_vars_set,
} from '@/commands/tenant/tenant-profile-store';

/** Prints every profile with a masked secret, the selected one marked, and where it is defined. */
export function execute_list_profiles(global_profile: string | undefined): void {
  const file = try_load_config_file();
  const stored = read_store();
  const names = profile_names(file, stored);
  const selected = select_profile_name(global_profile, file, stored);

  if (names.length === 0) {
    logger.info('No tenant profiles yet. Add one with "atlas tenants add <name> --tenant-id ..."');
  } else {
    print_profile_rows(names, selected, file, stored);
  }
  if (names.length > 0 && !names.includes(selected)) {
    logger.warn(unknown_profile_message(selected, names));
  }
  const env = process.env.ATLAS_PROFILE || undefined;
  if (env !== undefined) {
    logger.info(`ATLAS_PROFILE selects "${env}" for this shell`);
  }
  warn_graph_env_vars_set();
}

/** Makes a profile the stored active profile. */
export function execute_use_profile(name: string): void {
  const file = try_load_config_file();
  update_store((stored) => {
    if (find_profile(name, file, stored) === undefined) {
      throw new Error(unknown_profile_message(name, profile_names(file, stored)));
    }
    return build_store(stored, stored.tenants ?? {}, name);
  });
  logger.success(`Active tenant profile is now "${name}"`);

  const env = process.env.ATLAS_PROFILE || undefined;
  if (env !== undefined && env !== name) {
    logger.warn(`ATLAS_PROFILE is set to "${env}", which overrides the stored active profile.`);
  }
}

/** Removes a profile from the encrypted store; the active one needs `--yes`. */
export function execute_remove_profile(name: string, options: { readonly yes?: boolean }): void {
  const file = try_load_config_file();
  let was_active = false;
  update_store((stored) => {
    was_active = assert_removable(name, file, stored, options.yes === true);
    const remaining = { ...stored.tenants };
    delete remaining[name];
    return build_store(stored, remaining, was_active ? undefined : stored.active_tenant);
  });
  logger.success(`Removed tenant profile "${name}" from the encrypted store`);
  if (was_active) {
    logger.info('No profile is active now; run "atlas tenants use <name>" to pick one.');
  }
  if (list_profiles(file)[name] !== undefined) {
    logger.warn(`"${name}" still exists in atlas.config.json and remains available there.`);
  }
}

/**
 * Refuses a removal the store cannot perform: a profile only in atlas.config.json, an unknown
 * name, or the active profile without `--yes`. Returns whether the profile was the active one.
 */
function assert_removable(
  name: string,
  file: StoredConfig,
  stored: StoredConfig,
  confirmed: boolean,
): boolean {
  if (stored.tenants?.[name] === undefined) {
    if (list_profiles(file)[name] !== undefined) {
      throw new Error(
        `Tenant profile "${name}" is defined in atlas.config.json, not the encrypted store. ` +
          'Remove it by editing that file.',
      );
    }
    throw new Error(unknown_profile_message(name, profile_names(file, stored)));
  }
  const is_active = stored.active_tenant === name;
  if (is_active && !confirmed) {
    throw new Error(
      `"${name}" is the active tenant profile. Pass --yes to remove it; no profile will be active.`,
    );
  }
  return is_active;
}

/** One row per profile: name, tenant, client, masked secret, and where it is defined. */
function print_profile_rows(
  names: readonly string[],
  selected: string,
  file: StoredConfig,
  stored: StoredConfig,
): void {
  const width = Math.max(...names.map((n) => n.length));
  const file_names = Object.keys(list_profiles(file));
  for (const name of names) {
    const profile = find_profile(name, file, stored) ?? {};
    const marker = name === selected ? '*' : ' ';
    const secret =
      profile.client_secret === undefined ? '<unset>' : mask_secret(profile.client_secret);
    const in_store = stored.tenants?.[name] !== undefined;
    const source =
      in_store && file_names.includes(name) ? 'both' : in_store ? 'secure store' : 'config file';
    logger.info(
      `${marker} ${name.padEnd(width)}  tenant ${profile.tenant_id ?? '<unset>'}  ` +
        `client ${profile.client_id ?? '<unset>'}  secret ${secret}  (${source})`,
    );
  }
}
