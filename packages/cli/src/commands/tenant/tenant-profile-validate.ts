import {
  find_profile,
  profile_names,
  read_env_overrides,
  select_profile_name,
  try_load_config_file,
  unknown_profile_message,
} from '@wisecom/atlas-core';
import { probe_graph, probe_s3 } from '@/commands/tenant/config-probes';
import { read_graph_env_overrides, read_store } from '@/commands/tenant/tenant-profile-store';

export interface ValidateProfilesOptions {
  readonly all?: boolean;
}

interface ValidateScope {
  readonly name: string | undefined;
  readonly all: boolean;
  readonly names: string[];
  readonly selected: string;
  readonly env_only: boolean;
}

/**
 * Live-checks the Graph credentials of one profile (the selected one by default) or of every
 * profile, then S3 once, since all profiles share the same storage. Sets exit code 1 on any failure.
 */
export async function execute_validate_profiles(
  global_profile: string | undefined,
  name: string | undefined,
  options: ValidateProfilesOptions,
): Promise<void> {
  if (name !== undefined && options.all === true) {
    throw new Error('Pass either a profile name or --all, not both.');
  }
  const file = try_load_config_file();
  const stored = read_store();
  const names = profile_names(file, stored);
  const selected = select_profile_name(global_profile, file, stored);
  const env_graph = read_graph_env_overrides();
  // ATLAS_* Graph variables can stand in for a profile that is not stored (env-only setups).
  const targets = resolve_validate_targets({
    name,
    all: options.all === true,
    names,
    selected,
    env_only: Object.keys(env_graph).length > 0,
  });

  let ok = true;
  for (const target of targets) {
    const profile = find_profile(target, file, stored) ?? {};
    // ATLAS_* Graph variables describe the selected profile only, so they never reach the others.
    const credentials = target === selected ? { ...profile, ...env_graph } : profile;
    if (!(await probe_graph(credentials, target))) ok = false;
  }

  if (!(await probe_s3({ ...file, ...stored, ...read_env_overrides() }))) ok = false;
  if (!ok) process.exitCode = 1;
}

/** Picks the profiles to validate; a name must be stored, or be the selected profile backed by ATLAS_* credentials. */
function resolve_validate_targets(scope: ValidateScope): string[] {
  if (scope.all && scope.names.length === 0 && !scope.env_only) {
    throw new Error('No tenant profiles to validate. Add one with "atlas tenants add".');
  }
  // With no stored profiles, the ATLAS_* Graph variables describe the selected profile.
  let targets: string[];
  if (!scope.all) {
    targets = [scope.name ?? scope.selected];
  } else {
    targets = scope.names.length > 0 ? scope.names : [scope.selected];
  }
  for (const target of targets) {
    const from_env = target === scope.selected && scope.env_only;
    if (!scope.names.includes(target) && !from_env) {
      throw new Error(unknown_profile_message(target, scope.names));
    }
  }
  return targets;
}
