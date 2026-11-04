import {
  UnreadableContentError,
  type TeamsChannelCursor,
  type TeamsChannelShard,
  type TeamsSnapshotIndex,
} from '@wisecom/atlas-types';
import { assert_readable_format_version } from '@/services/shared/format-version';

/**
 * A field kind. A trailing `?` marks the field optional: it may be absent but must match the kind
 * when present.
 */
type Kind = 'string' | 'number' | 'boolean' | 'array' | 'record';
type FieldSpec = Kind | `${Kind}?`;
type Shape = Readonly<Record<string, FieldSpec>>;

const INDEX_SHAPE: Shape = {
  id: 'string',
  tenant_id: 'string',
  team_id: 'string',
  snapshot_id: 'string',
  created_at: 'string',
  team: 'record',
  members: 'array',
  channels: 'array',
  totals: 'record',
};

const INDEX_CHANNEL_SHAPE: Shape = {
  channel_id: 'string',
  display_name: 'string?',
  shard_key: 'string',
  shard_checksum: 'string',
  deleted_at: 'string?',
  thread_count: 'number',
  message_count: 'number',
  size_bytes: 'number',
};

const INDEX_TOTALS_SHAPE: Shape = {
  thread_count: 'number',
  message_count: 'number',
  size_bytes: 'number',
};

const SHARD_SHAPE: Shape = {
  team_id: 'string',
  channel_id: 'string',
  channel: 'record',
  members: 'array',
  members_from_team: 'boolean?',
  tabs: 'array',
  shared_with_teams: 'array?',
  files_folder: 'record?',
  files_folder_unavailable: 'boolean?',
  read_mode: 'string',
  threads: 'record',
};

const MESSAGE_REF_SHAPE: Shape = {
  storage_key: 'string',
  checksum: 'string',
  size_bytes: 'number',
  last_modified_at: 'string',
  deleted_at: 'string?',
  kept: 'record?',
  hosted: 'record',
  hosted_missing: 'array?',
};

const KEPT_REF_SHAPE: Shape = {
  storage_key: 'string',
  checksum: 'string',
  size_bytes: 'number',
  hosted: 'record',
};

const THREAD_SHAPE: Shape = {
  root: 'record',
  replies: 'record',
  deleted_at: 'string?',
};

const CURSOR_SHAPE: Shape = {
  team_id: 'string',
  channel_id: 'string',
  delta_link: 'string?',
  baseline_shard_key: 'string',
  failed_roots: 'record?',
  hosted_recheck: 'record?',
  updated_at: 'string',
};

const FAILED_ROOT_SHAPE: Shape = {
  item_id: 'string',
  attempts: 'number',
};

const HOSTED_REF_SHAPE: Shape = {
  storage_key: 'string',
  checksum: 'string',
  size_bytes: 'number',
};

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kind_matches(kind: string, value: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'record':
      return is_record(value);
    default:
      return false;
  }
}

/**
 * Checks each field of `value` against `shape`, naming the first field that is missing or mistyped,
 * and returns the narrowed object so callers read its fields without casting.
 */
function assert_fields(
  key: string,
  label: string,
  value: unknown,
  shape: Shape,
): Record<string, unknown> {
  if (!is_record(value)) {
    throw new UnreadableContentError(`The ${label} at ${key} is not a JSON object`);
  }
  for (const [field, spec] of Object.entries(shape)) {
    const optional = spec.endsWith('?');
    const actual = value[field];
    if (actual === undefined && optional) continue;
    if (!kind_matches(optional ? spec.slice(0, -1) : spec, actual)) {
      throw new UnreadableContentError(
        `The ${label} at ${key} has a missing or mistyped field: ${field}`,
      );
    }
  }
  return value;
}

/** Checks the body is an object of a readable format version and has the fields `shape` names. */
function assert_teams_object(
  key: string,
  label: string,
  body: unknown,
  shape: Shape,
): Record<string, unknown> {
  if (is_record(body)) assert_readable_format_version(key, body.format_version);
  return assert_fields(key, label, body, shape);
}

/**
 * The index as stored: `created_at` is the ISO string JSON.stringify wrote, parsed after the
 * shape check.
 */
export type StoredTeamsIndex = Omit<TeamsSnapshotIndex, 'created_at'> & {
  readonly created_at: string;
};

/** Checks a snapshot index body's version, top-level fields, channel rows, and totals. */
export function assert_index_shape(key: string, body: unknown): asserts body is StoredTeamsIndex {
  const index = assert_teams_object(key, 'Teams snapshot index', body, INDEX_SHAPE);
  assert_fields(key, 'Teams snapshot index totals', index.totals, INDEX_TOTALS_SHAPE);
  for (const channel of elements(index.channels)) {
    assert_fields(key, 'Teams snapshot index channel', channel, INDEX_CHANNEL_SHAPE);
  }
}

/** Checks a channel shard body's version, fields, read mode, and every stored message reference. */
export function assert_shard_shape(key: string, body: unknown): asserts body is TeamsChannelShard {
  const shard = assert_teams_object(key, 'Teams channel shard', body, SHARD_SHAPE);
  if (shard.read_mode !== 'delta' && shard.read_mode !== 'full') {
    throw new UnreadableContentError(`The Teams channel shard at ${key} has an unknown read_mode`);
  }
  for (const value of record_values(shard.threads)) {
    const thread = assert_fields(key, 'Teams channel shard thread', value, THREAD_SHAPE);
    assert_message_ref(key, thread.root);
    for (const reply of record_values(thread.replies)) assert_message_ref(key, reply);
  }
}

/** Checks one stored message, root or reply, its hosted content, and its optional kept version. */
function assert_message_ref(key: string, value: unknown): void {
  const message = assert_fields(key, 'Teams channel shard message', value, MESSAGE_REF_SHAPE);
  assert_record_entries(
    key,
    'Teams channel shard hosted content',
    message.hosted,
    HOSTED_REF_SHAPE,
  );
  if (message.kept !== undefined) {
    const kept = assert_fields(
      key,
      'Teams channel shard kept message',
      message.kept,
      KEPT_REF_SHAPE,
    );
    assert_record_entries(
      key,
      'Teams channel shard kept hosted content',
      kept.hosted,
      HOSTED_REF_SHAPE,
    );
  }
}

/** Checks a channel cursor body's version, fields, failed-root records, and hosted-recheck counts. */
export function assert_cursor_shape(
  key: string,
  body: unknown,
): asserts body is TeamsChannelCursor {
  const cursor = assert_teams_object(key, 'Teams channel cursor', body, CURSOR_SHAPE);
  assert_record_entries(
    key,
    'Teams channel cursor failed root',
    cursor.failed_roots,
    FAILED_ROOT_SHAPE,
  );
  assert_hosted_recheck_counts(key, cursor.hosted_recheck);
}

/** The elements of a field already checked as an array; empty otherwise. */
function elements(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The values of a field already checked as a record; empty otherwise. */
function record_values(value: unknown): unknown[] {
  return is_record(value) ? Object.values(value) : [];
}

/** Checks every entry of a record field against `shape`. */
function assert_record_entries(key: string, label: string, value: unknown, shape: Shape): void {
  for (const entry of record_values(value)) assert_fields(key, label, entry, shape);
}

/** Checks every hosted-recheck count is a finite number. */
function assert_hosted_recheck_counts(key: string, value: unknown): void {
  for (const attempts of record_values(value)) {
    if (typeof attempts !== 'number' || !Number.isFinite(attempts)) {
      throw new UnreadableContentError(
        `The Teams channel cursor at ${key} has a mistyped hosted_recheck count`,
      );
    }
  }
}
