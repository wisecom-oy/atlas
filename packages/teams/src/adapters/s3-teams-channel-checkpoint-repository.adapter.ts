import { injectable } from 'inversify';
import type {
  TeamsChannelCheckpointHead,
  TeamsChannelCheckpointHostedEntry,
  TeamsChannelCheckpointRepository,
  TeamsChannelCheckpointSegment,
  TenantContext,
} from '@wisecom/atlas-types';
import { UnreadableContentError } from '@wisecom/atlas-types';
import { ConcurrencySemaphore } from '@wisecom/atlas-core/services/shared/concurrency-semaphore';
import { load_encrypted_json } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { write_encrypted_json } from '@wisecom/atlas-core/services/shared/stored-json-writer';
import {
  assert_checkpoint_head_shape,
  assert_checkpoint_hosted_entry_shape,
  assert_checkpoint_segment_shape,
} from '@/services/shared/teams-checkpoint-shape';
import {
  teams_checkpoint_head_key,
  teams_checkpoint_hosted_key,
  teams_checkpoint_hosted_prefix,
  teams_checkpoint_prefix,
  teams_checkpoint_segment_key,
} from '@/services/shared/storage-keys';

/** Hosted-journal entries read at once on resume. Each is a small GET. */
const HOSTED_ENTRY_READ_CONCURRENCY = 8;

/**
 * A checkpoint object is rewritten as the read advances, once per page and per hosted item, so it
 * is overwritten in place and never read back: its checks must cost no extra request.
 */
const CHECKPOINT_WRITE = { write: 'overwrite', confirm_read_back: false } as const;

/**
 * Persists one channel's read checkpoint as encrypted JSON: a head, append-only segments, and one
 * small object per hosted-journal entry.
 */
@injectable()
export class S3TeamsChannelCheckpointRepository implements TeamsChannelCheckpointRepository {
  /** Loads one channel's checkpoint head, or undefined when none was saved. */
  async load_head(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsChannelCheckpointHead | undefined> {
    const key = teams_checkpoint_head_key(team_id, channel_id);
    const head = await load_encrypted_json<unknown>(ctx, key);
    if (head === undefined) return undefined;
    return require_checkpoint_head(head, key);
  }

  /** Loads one segment a head names. A missing segment is damage, so it throws. */
  async load_segment(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
    name: string,
  ): Promise<TeamsChannelCheckpointSegment> {
    const key = teams_checkpoint_segment_key(team_id, channel_id, name);
    const segment = await load_encrypted_json<unknown>(ctx, key);
    if (segment === undefined) {
      throw new UnreadableContentError(`The Teams channel checkpoint segment at ${key} is missing`);
    }
    assert_checkpoint_segment_shape(key, segment);
    return segment;
  }

  /** Encrypts and saves one segment under its channel's checkpoint prefix. */
  async save_segment(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
    name: string,
    segment: TeamsChannelCheckpointSegment,
  ): Promise<void> {
    const key = teams_checkpoint_segment_key(team_id, channel_id, name);
    await write_encrypted_json(
      ctx,
      {
        key,
        label: 'Teams channel checkpoint segment',
        reader_check: (parsed) => assert_checkpoint_segment_shape(key, parsed),
        ...CHECKPOINT_WRITE,
      },
      segment,
    );
  }

  /** Encrypts and saves one channel's head under its team and channel key. */
  async save_head(ctx: TenantContext, head: TeamsChannelCheckpointHead): Promise<void> {
    const key = teams_checkpoint_head_key(head.team_id, head.channel_id);
    await write_encrypted_json(
      ctx,
      {
        key,
        label: 'Teams channel checkpoint head',
        reader_check: require_checkpoint_head,
        ...CHECKPOINT_WRITE,
      },
      head,
    );
  }

  /** Encrypts and saves one hosted-journal entry under its channel's checkpoint prefix. */
  async save_hosted_entry(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
    name: string,
    entry: TeamsChannelCheckpointHostedEntry,
  ): Promise<void> {
    const key = teams_checkpoint_hosted_key(team_id, channel_id, name);
    await write_encrypted_json(
      ctx,
      {
        key,
        label: 'Teams channel checkpoint hosted entry',
        reader_check: (parsed) => assert_checkpoint_hosted_entry_shape(key, parsed),
        ...CHECKPOINT_WRITE,
      },
      entry,
    );
  }

  /** Lists and loads every hosted-journal entry of one channel, a few reads at a time. */
  async load_hosted_entries(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsChannelCheckpointHostedEntry[]> {
    const keys = await ctx.storage.list(teams_checkpoint_hosted_prefix(team_id, channel_id));
    const semaphore = new ConcurrencySemaphore(HOSTED_ENTRY_READ_CONCURRENCY);
    return Promise.all(
      keys.map(async (key) => {
        await semaphore.acquire();
        try {
          return await load_hosted_entry(ctx, key);
        } finally {
          semaphore.release();
        }
      }),
    );
  }

  /** Deletes every object of one channel's checkpoint: head, segments, and hosted entries. */
  async delete_channel(ctx: TenantContext, team_id: string, channel_id: string): Promise<void> {
    for (const key of await ctx.storage.list(teams_checkpoint_prefix(team_id, channel_id))) {
      await ctx.storage.delete(key);
    }
  }
}

/** Loads one listed hosted-journal entry. A missing or damaged entry throws. */
async function load_hosted_entry(
  ctx: TenantContext,
  key: string,
): Promise<TeamsChannelCheckpointHostedEntry> {
  const entry = await load_encrypted_json<unknown>(ctx, key);
  if (entry === undefined) {
    throw new UnreadableContentError(
      `The Teams channel checkpoint hosted entry at ${key} is missing`,
    );
  }
  assert_checkpoint_hosted_entry_shape(key, entry);
  return entry;
}

/** The shape and identity checks of a parsed head body, shared by reader and writer. */
function require_checkpoint_head(head: unknown, key: string): TeamsChannelCheckpointHead {
  assert_checkpoint_head_shape(key, head);
  if (!names_head(head, key)) {
    throw new UnreadableContentError(
      `The Teams channel checkpoint at ${key} names a different team or channel than its key`,
    );
  }
  return head;
}

/** Whether a head body names the key it was read from. */
function names_head(head: TeamsChannelCheckpointHead, key: string): boolean {
  try {
    return teams_checkpoint_head_key(head.team_id, head.channel_id) === key;
  } catch {
    return false;
  }
}
