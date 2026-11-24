import { parse_team_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { ConfigError } from '@wisecom/atlas-types';

/**
 * Trims and lowercases a Teams team id, then requires it to be a GUID; see {@link parse_team_id},
 * which the SDK publishes so an inventory keys teams the same way.
 *
 * @throws ConfigError when the value is not a GUID.
 */
export function normalize_team_id(value: string): string {
  const team_id = parse_team_id(value);
  if (team_id === undefined) {
    throw new ConfigError(`Teams team id must be a GUID, got "${value}"`);
  }
  return team_id;
}
