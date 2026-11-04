import { build_drive_storage_keys } from '@wisecom/atlas-drive/shared/storage-keys';

/** Teams key layout. A URL in a segment means a caller skipped team resolution (issue #90). */
export const TEAMS_KEYS = build_drive_storage_keys('teams', (value) =>
  /^https?:\/\//i.test(value) ? ' -- expected a resolved team id, got a URL' : '',
);

/**
 * Builds the key for one hosted-content blob (inline image) of a team. Lives under the team's
 * data prefix so the team's blobs stay in one directory, and is named by the keyed content name.
 */
export function teams_hosted_content_key(team_id: string, content_name: string): string {
  TEAMS_KEYS.validate_key_segment(content_name);
  return `${TEAMS_KEYS.data_prefix_for(team_id)}hosted/${content_name}`;
}
