import {
  UnreadableContentError,
  type TeamsChannelCheckpointHead,
  type TeamsChannelCheckpointSegment,
} from '@wisecom/atlas-types';
import {
  assert_fields,
  assert_hosted_recheck_counts,
  assert_record_entries,
  assert_teams_object,
  elements,
  FAILED_ROOT_SHAPE,
  record_values,
  THREAD_SHAPE,
  type Shape,
} from '@/services/shared/teams-shape-fields';
import { HOSTED_REF_SHAPE } from '@/services/shared/teams-object-shape';

const CHECKPOINT_HEAD_SHAPE: Shape = {
  format_version: 'number',
  team_id: 'string',
  channel_id: 'string',
  baseline_shard_key: 'string?',
  start_link: 'string?',
  mode: 'string',
  phase: 'string',
  next_page: 'string?',
  pending_delta_link: 'string?',
  segments: 'array',
  failed_roots: 'record?',
  hosted_recheck: 'record?',
  updated_at: 'string',
};

const CHECKPOINT_SEGMENT_SHAPE: Shape = {
  threads: 'record',
  seen: 'array',
  hosted: 'record?',
};

const CHECKPOINT_MODES: readonly string[] = ['delta', 'full'];
const CHECKPOINT_PHASES: readonly string[] = ['delta', 'list', 'retry', 'done'];

/** Checks a checkpoint head's version, fields, mode and phase names, and failed-root records. */
export function assert_checkpoint_head_shape(
  key: string,
  body: unknown,
): asserts body is TeamsChannelCheckpointHead {
  const label = 'Teams channel checkpoint head';
  const head = assert_teams_object(key, label, body, CHECKPOINT_HEAD_SHAPE);
  const known_mode = CHECKPOINT_MODES.includes(head.mode as string);
  const known_phase = CHECKPOINT_PHASES.includes(head.phase as string);
  if (!known_mode || !known_phase) {
    throw new UnreadableContentError(`The ${label} at ${key} has an unknown mode or phase`);
  }
  if (!elements(head.segments).every((name) => typeof name === 'string')) {
    throw new UnreadableContentError(`The ${label} at ${key} has a bad segment name`);
  }
  assert_record_entries(key, `${label} failed root`, head.failed_roots, FAILED_ROOT_SHAPE);
  assert_hosted_recheck_counts(key, head.hosted_recheck);
}

/** Checks a checkpoint segment's fields, its thread entries (or removal markers), and seen IDs. */
export function assert_checkpoint_segment_shape(
  key: string,
  body: unknown,
): asserts body is TeamsChannelCheckpointSegment {
  const label = 'Teams channel checkpoint segment';
  const segment = assert_fields(key, label, body, CHECKPOINT_SEGMENT_SHAPE);
  for (const thread of record_values(segment.threads)) {
    if (thread !== null) assert_fields(key, `${label} thread`, thread, THREAD_SHAPE);
  }
  if (!elements(segment.seen).every((id) => typeof id === 'string')) {
    throw new UnreadableContentError(`The ${label} at ${key} has a bad seen ID`);
  }
  assert_record_entries(key, `${label} hosted content`, segment.hosted, HOSTED_REF_SHAPE);
}
