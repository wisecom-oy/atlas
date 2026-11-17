import { GUID_RE } from '@wisecom/atlas-core/utils/config-keys';
import { ConfigError } from '@wisecom/atlas-types';

/**
 * Trims and lowercases a Teams team id, then requires it to be a GUID. Graph ids are GUIDs and
 * storage keys embed the id verbatim, so a URL, a stray space, or an uppercase copy would create
 * a second prefix for the same team.
 */
export function normalize_team_id(value: string): string {
  const team_id = value.trim().toLowerCase();
  if (!GUID_RE.test(team_id)) {
    throw new ConfigError(`Teams team id must be a GUID, got "${value}"`);
  }
  return team_id;
}
