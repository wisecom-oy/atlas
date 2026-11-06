import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
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

/** A team's path segment, normalized the same way every other Teams key is. */
function team_key_segment(team_id: string): string {
  TEAMS_KEYS.validate_key_segment(team_id);
  return normalize_owner_id(team_id);
}

/**
 * Root of every channel shard. Kept outside the manifest prefix so a listing of a team's manifests
 * returns snapshot indexes only.
 */
const SHARD_ROOT = 'teams/shards';

/** Key of one channel's delta cursor. Lives under `_meta` so cursors never sit next to content. */
export function teams_cursor_key(team_id: string, channel_id: string): string {
  TEAMS_KEYS.validate_key_segment(channel_id);
  return `${teams_cursor_prefix_for(team_id)}${channel_id}.json`;
}

/** Prefix listing every channel cursor of one team. */
export function teams_cursor_prefix_for(team_id: string): string {
  return `${teams_meta_prefix_for(team_id)}channels/`;
}

/** Prefix of every object of one channel's read checkpoint: its head and its segments. */
export function teams_checkpoint_prefix(team_id: string, channel_id: string): string {
  TEAMS_KEYS.validate_key_segment(channel_id);
  return `${teams_meta_prefix_for(team_id)}checkpoints/${channel_id}/`;
}

/** Key of one channel's read checkpoint head. */
export function teams_checkpoint_head_key(team_id: string, channel_id: string): string {
  return `${teams_checkpoint_prefix(team_id, channel_id)}head.json`;
}

/** Key of one checkpoint segment, named by the run and its position, e.g. `seg-<run>-<n>`. */
export function teams_checkpoint_segment_key(
  team_id: string,
  channel_id: string,
  segment_name: string,
): string {
  TEAMS_KEYS.validate_key_segment(segment_name);
  return `${teams_checkpoint_prefix(team_id, channel_id)}${segment_name}.json`;
}

/** Prefix of everything a team keeps under `_meta`, which deletion removes with the team. */
export function teams_meta_prefix_for(team_id: string): string {
  return `${TEAMS_KEYS.meta_prefix}/${team_key_segment(team_id)}/`;
}

/** Prefix of every channel shard of one team, which deletion removes with the team. */
export function teams_shard_prefix_for(team_id: string): string {
  return `${SHARD_ROOT}/${team_key_segment(team_id)}/`;
}

/**
 * Key of a channel shard, `teams/shards/{team}/{channel}/{content}.json`. Named by the keyed content
 * name, so an unchanged channel maps to the same object.
 */
export function teams_channel_shard_key(
  team_id: string,
  channel_id: string,
  content_name: string,
): string {
  TEAMS_KEYS.validate_key_segment(channel_id);
  TEAMS_KEYS.validate_key_segment(content_name);
  return `${teams_shard_prefix_for(team_id)}${channel_id}/${content_name}.json`;
}

const INDEX_OBJECT_NAME = /^[^/]+\.json$/;
const TEAM_INDEX_OBJECT = /^[^/]+\/[^/]+\.json$/;

/** Keeps the snapshot index objects of one team (`{snapshot}.json`) under its manifest prefix. */
export function team_index_keys(keys: string[], team_id: string): string[] {
  const prefix = TEAMS_KEYS.manifest_prefix_for(team_id);
  return keys.filter(
    (key) => key.startsWith(prefix) && INDEX_OBJECT_NAME.test(key.slice(prefix.length)),
  );
}

/** Keeps every snapshot index object of the tenant (`{team}/{snapshot}.json`) under the manifests root. */
export function all_index_keys(keys: string[]): string[] {
  const root = TEAMS_KEYS.manifest_root_prefix();
  return keys.filter(
    (key) => key.startsWith(root) && TEAM_INDEX_OBJECT.test(key.slice(root.length)),
  );
}
