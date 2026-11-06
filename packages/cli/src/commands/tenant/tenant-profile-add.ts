import type { TenantProfile } from '@wisecom/atlas-core';
import {
  PROFILE_NAME_RE,
  TENANT_KEYS,
  find_profile,
  list_profiles,
  logger,
  profile_names,
  try_load_config_file,
  write_secure_config,
} from '@wisecom/atlas-core';
import { probe_graph } from '@/commands/tenant/config-probes';
import { build_store, read_store } from '@/commands/tenant/tenant-profile-store';
import { resolve_secret_option } from '@/utils/secret-option';

export interface AddProfileOptions {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly replace?: boolean;
}

/**
 * Saves a named tenant profile to the encrypted store, activating it when it is the first
 * profile, then live-probes its Graph credentials.
 */
export async function execute_add_profile(name: string, options: AddProfileOptions): Promise<void> {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid profile name "${name}". Use 1-32 lowercase letters, digits or dashes.`,
    );
  }

  const credentials = build_credentials(options);
  const file = try_load_config_file();
  const stored = read_store();

  if (find_profile(name, file, stored) !== undefined && options.replace !== true) {
    throw new Error(
      `Tenant profile "${name}" already exists. Pass --replace to overwrite its credentials.`,
    );
  }

  const activate = stored.active_tenant === undefined && profile_names(file, stored).length === 0;
  write_secure_config(
    build_store(
      stored,
      { ...stored.tenants, [name]: credentials },
      activate ? name : stored.active_tenant,
    ),
  );
  logger.success(`Saved tenant profile "${name}" to the encrypted store`);
  if (activate) {
    logger.info(`"${name}" is the first profile, so it is now the active profile`);
  }
  if (list_profiles(file)[name] !== undefined) {
    logger.info(`The store copy of "${name}" now overrides the one in atlas.config.json`);
  }

  if (!(await probe_graph(credentials, name))) {
    process.exitCode = 1;
    logger.warn(
      `Profile "${name}" was saved despite the failed check. Fix the credentials and ` +
        're-run with --replace.',
    );
  }
}

/** Resolves the secret (`-` reads stdin) and validates all three credentials before any write. */
function build_credentials(options: AddProfileOptions): TenantProfile {
  const client_secret = resolve_secret_option(options.clientSecret, '--client-secret') ?? '';
  const inputs: Record<string, string> = {
    'tenant-id': options.tenantId,
    'client-id': options.clientId,
    'client-secret': client_secret,
  };
  for (const spec of TENANT_KEYS) {
    const error = spec.validate(inputs[spec.key] ?? '');
    if (error !== null) {
      throw new Error(`Invalid --${spec.key}: ${error}`);
    }
  }
  return {
    tenant_id: options.tenantId,
    client_id: options.clientId,
    client_secret,
  };
}
