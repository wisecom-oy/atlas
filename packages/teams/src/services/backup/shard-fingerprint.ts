import type { TeamsChannelShard } from '@wisecom/atlas-types';
import { canonical_json } from '@/services/shared/canonical-json';

/**
 * Serializes the content a channel shard records. The read mode is left out, because a delta read
 * and a full read of unchanged content produce the same shard. Member and tab lists are sorted by
 * id first: Graph returns them in no stable order, which would otherwise make every unchanged run
 * look changed.
 */
export function shard_fingerprint(shard: TeamsChannelShard): string {
  return canonical_json({
    ...shard,
    read_mode: undefined,
    members: [...shard.members].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    tabs: [...shard.tabs].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  });
}
