import { UnreadableContentError } from '@wisecom/atlas-types';
import { assert_readable_format_version } from '@/services/shared/format-version';

/**
 * A field kind. A trailing `?` marks the field optional: it may be absent but must match the kind
 * when present.
 */
type Kind = 'string' | 'number' | 'boolean' | 'array' | 'record';
type FieldSpec = Kind | `${Kind}?`;
export type Shape = Readonly<Record<string, FieldSpec>>;

/** The failed-root records a cursor and a checkpoint head both carry. */
export const FAILED_ROOT_SHAPE: Shape = {
  item_id: 'string',
  attempts: 'number',
};

/** A thread row: its root message and its replies. */
export const THREAD_SHAPE: Shape = {
  root: 'record',
  replies: 'record',
  deleted_at: 'string?',
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
export function assert_fields(
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
export function assert_teams_object(
  key: string,
  label: string,
  body: unknown,
  shape: Shape,
): Record<string, unknown> {
  if (is_record(body)) assert_readable_format_version(key, body.format_version);
  return assert_fields(key, label, body, shape);
}

/** The elements of a field already checked as an array; empty otherwise. */
export function elements(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The values of a field already checked as a record; empty otherwise. */
export function record_values(value: unknown): unknown[] {
  return is_record(value) ? Object.values(value) : [];
}

/** Checks every entry of a record field against `shape`. */
export function assert_record_entries(
  key: string,
  label: string,
  value: unknown,
  shape: Shape,
): void {
  for (const entry of record_values(value)) assert_fields(key, label, entry, shape);
}

/** Checks every hosted-recheck count is a finite number. */
export function assert_hosted_recheck_counts(key: string, value: unknown): void {
  for (const attempts of record_values(value)) {
    if (typeof attempts !== 'number' || !Number.isFinite(attempts)) {
      throw new UnreadableContentError(
        `The Teams channel cursor at ${key} has a mistyped hosted_recheck count`,
      );
    }
  }
}
