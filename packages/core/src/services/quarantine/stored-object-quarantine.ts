import type {
  HeldOwnerLease,
  OwnerLeasePort,
  OwnerLeaseWorkload,
  QuarantinedObjectKind,
  QuarantineResult,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { NotFoundError, StorageError, UnreadableContentError } from '@wisecom/atlas-types';
import { run_with_owner_lease } from '@/services/lease/run-with-owner-lease';

/** Prefix every quarantined object is moved under, keeping its original key after it. */
export const QUARANTINE_PREFIX = '_quarantine/';

/** How one workload recognises its manifests and version indexes, and reads one of them. */
export interface QuarantineTarget {
  /** Workload name for operator-facing messages, e.g. `OneDrive`. */
  readonly workload: string;
  /** The namespace of the owner lease a quarantine of this workload takes. */
  readonly lease_workload: OwnerLeaseWorkload;
  /** What the workload quarantines, e.g. `OneDrive manifests and version indexes`. */
  readonly accepts: string;
  /** The kind of object a key names, or undefined when the workload never writes such a key. */
  readonly kind_of: (storage_key: string) => QuarantinedObjectKind | undefined;
  /**
   * Reads the object exactly as the workload's listings do. Resolves `undefined` when it is absent
   * and raises `UnreadableContentError` when it fails to decrypt, parse, or identify.
   */
  readonly read: (ctx: TenantContext, storage_key: string) => Promise<unknown>;
  /**
   * Runs once the object has moved, for state that described it. Contacts and Calendar drop the
   * mailbox's delta cursor there, since its links may describe the snapshot just moved aside.
   * Outlook, OneDrive and SharePoint drop a moved manifest's row from the summary index. The
   * lease is checked before the hook runs and passed in for any write the hook makes (#623).
   */
  readonly after_move?:
    ((ctx: TenantContext, storage_key: string, lease: HeldOwnerLease) => Promise<void>) | undefined;
}

/**
 * Whether every `/`-separated segment of a key is a plain name: not empty, not `.` or `..`, and
 * free of `\` and NUL. A backend that normalises paths would otherwise resolve
 * `manifests/../identity-registry.json` to a healthy object outside the workload, which fails its
 * scope-bound decrypt and would be moved as damage.
 */
export function has_plain_segments(storage_key: string): boolean {
  return storage_key
    .split('/')
    .every(
      (segment) => segment !== '' && segment !== '.' && segment !== '..' && !/[\\\0]/.test(segment),
    );
}

/**
 * Moves one unreadable manifest or version index to `_quarantine/{key}` (issue #631).
 *
 * Opens the tenant with a write context, since the move writes and deletes, then runs the move
 * under the lease of the owner the key names: a backup of that owner reads its manifests to pick
 * a head, and must not do so while one is being moved (issue #623).
 *
 * @throws OwnerBusyError when another operation holds the owner.
 */
export async function quarantine_unreadable_object(
  tenant_factory: TenantContextFactory,
  leases: OwnerLeasePort,
  target: QuarantineTarget,
  tenant_id: string,
  storage_key: string,
): Promise<QuarantineResult> {
  const kind = has_plain_segments(storage_key) ? target.kind_of(storage_key) : undefined;
  if (kind === undefined) {
    throw new Error(`Only ${target.accepts} can be quarantined, and ${storage_key} is not one`);
  }
  const ctx = await tenant_factory.create(tenant_id);
  try {
    const owner_id = owner_segment_of(target.lease_workload, storage_key);
    return await run_with_owner_lease(
      leases,
      ctx,
      { workload: target.lease_workload, owner_id, operation: 'quarantine' },
      async (lease) => {
        const reason = await read_damage_reason(ctx, target, storage_key);
        lease.assert_held();
        const quarantine_key = await move_aside(ctx, storage_key);
        lease.assert_held();
        await target.after_move?.(ctx, storage_key, lease);
        return { storage_key, quarantine_key, kind, reason };
      },
    );
  } finally {
    ctx.destroy();
  }
}

/**
 * The owner segment of a manifest or version index key the target accepted. Outlook keeps the
 * owner second (`manifests/{owner}/...`); every other workload keeps it third
 * (`{workload}/manifests/{owner}/...`).
 */
function owner_segment_of(workload: OwnerLeaseWorkload, storage_key: string): string {
  return storage_key.split('/')[workload === 'outlook' ? 1 : 2] ?? '';
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
 * Copy first, so a failure between the two steps leaves a duplicate rather than a loss, and read
 * the copy back before the removal: an original is never removed unless its bytes demonstrably
 * sit at the quarantine key. An earlier
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
  const original = await ctx.storage.get(storage_key);
  await ctx.storage.copy(storage_key, quarantine_key);
  const copied = await ctx.storage.get(quarantine_key).catch(() => undefined);
  if (copied === undefined || !copied.equals(original)) {
    throw new StorageError(
      `The quarantined copy at ${quarantine_key} does not match ${storage_key}; the original was left in place`,
    );
  }
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
