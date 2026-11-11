import type {
  QuarantinedObjectKind,
  QuarantineResult,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { NotFoundError, UnreadableContentError } from '@wisecom/atlas-types';

/** Prefix every quarantined object is moved under, keeping its original key after it. */
export const QUARANTINE_PREFIX = '_quarantine/';

/** How one workload recognises its manifests and version indexes, and reads one of them. */
export interface QuarantineTarget {
  /** Workload name for operator-facing messages, e.g. `OneDrive`. */
  readonly workload: string;
  /** What the workload quarantines, e.g. `OneDrive manifests and version indexes`. */
  readonly accepts: string;
  /** The kind of object a key names, or undefined when the workload never writes such a key. */
  readonly kind_of: (storage_key: string) => QuarantinedObjectKind | undefined;
  /**
   * Reads the object exactly as the workload's listings do. Resolves `undefined` when it is absent
   * and raises `UnreadableContentError` when it fails to decrypt, parse, or identify.
   */
  readonly read: (ctx: TenantContext, storage_key: string) => Promise<unknown>;
}

/**
 * Moves one unreadable manifest or version index to `_quarantine/{key}` (issue #631).
 *
 * Opens the tenant with a write context, since the move writes and deletes, then runs the move.
 */
export async function quarantine_unreadable_object(
  tenant_factory: TenantContextFactory,
  target: QuarantineTarget,
  tenant_id: string,
  storage_key: string,
): Promise<QuarantineResult> {
  const kind = target.kind_of(storage_key);
  if (kind === undefined) {
    throw new Error(`Only ${target.accepts} can be quarantined, and ${storage_key} is not one`);
  }
  const ctx = await tenant_factory.create(tenant_id);
  try {
    const reason = await read_damage_reason(ctx, target, storage_key);
    const quarantine_key = await move_aside(ctx, storage_key);
    return { storage_key, quarantine_key, kind, reason };
  } finally {
    ctx.destroy();
  }
}

/**
 * Returns why the object cannot be read, and refuses one that is absent or reads cleanly.
 *
 * The same reader the listings use decides, so an object is quarantined only when the commands
 * that reported it would keep reporting it. A clean read is refused rather than moved: moving a
 * healthy manifest out of a chain hides a snapshot and every change it recorded.
 */
async function read_damage_reason(
  ctx: TenantContext,
  target: QuarantineTarget,
  storage_key: string,
): Promise<string> {
  let value: unknown;
  try {
    value = await target.read(ctx, storage_key);
  } catch (err) {
    if (err instanceof UnreadableContentError) return err.message;
    throw err;
  }
  if (value === undefined) {
    throw new NotFoundError(`No ${target.workload} object exists at ${storage_key}`);
  }
  throw new NotFoundError(
    `The ${target.workload} object at ${storage_key} reads cleanly, so it was not quarantined`,
  );
}

/**
 * Copies the object's bytes unchanged under the quarantine prefix, then removes the original.
 *
 * Copy first, so a failure between the two steps leaves a duplicate rather than a loss. An earlier
 * quarantined copy of the same key is never overwritten: the new copy takes a timestamp suffix.
 * In a versioned bucket the removal only adds a delete marker, so a version under Object Lock
 * stays retained exactly as it was; a backend that refuses the removal raises
 * `ObjectLockRetainedError` and the copy stays in place.
 */
async function move_aside(ctx: TenantContext, storage_key: string): Promise<string> {
  const base_key = `${QUARANTINE_PREFIX}${storage_key}`;
  const quarantine_key = (await ctx.storage.exists(base_key))
    ? `${base_key}.${Date.now()}`
    : base_key;
  await ctx.storage.copy(storage_key, quarantine_key);
  await ctx.storage.delete(storage_key);
  return quarantine_key;
}

/**
 * Where quarantined copies of the objects under `prefixes` live. Erasing an owner's data covers
 * these too: a quarantined manifest still lists that owner's files and messages (issue #631).
 */
export function quarantined_copies_of(prefixes: readonly string[]): string[] {
  return prefixes.map((prefix) => `${QUARANTINE_PREFIX}${prefix}`);
}
