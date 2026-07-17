import { inject, injectable } from 'inversify';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { TenantContextFactory, TenantContext } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { Manifest, ManifestEntry } from '@wisecom/atlas-types';
import type {
  VerificationOptions,
  VerificationResult,
  VerificationUseCase,
} from '@wisecom/atlas-types';
import { TENANT_CONTEXT_FACTORY_TOKEN, MANIFEST_REPOSITORY_TOKEN } from '@wisecom/atlas-types';
import { merge_snapshot_entries } from '@/services/shared/manifest-entry-merger';

/** A single verifiable object: a message blob or an attachment blob. */
interface CheckItem {
  /** Operator-facing identifier: object_id, or object_id/attachment_id. */
  readonly id: string;
  readonly storage_key: string;
  readonly checksum: string;
}

@injectable()
export class VerificationService implements VerificationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /**
   * Verifies the full restorable state of a snapshot, not just its delta:
   *   1. Resolves the merged entry set across the snapshot's manifest chain
   *      (same routine restore uses, so the two views cannot drift).
   *   2. Checks every referenced object -- message blobs and attachments.
   * Full mode downloads, decrypts, and re-hashes each object; fast mode only
   * checks existence. Entries without a stored blob (empty storage_key, e.g.
   * attachments skipped by pre-fix backups) are reported as unverifiable.
   */
  async verify_snapshot_integrity(
    tenant_id: string,
    snapshot_id: string,
    options: VerificationOptions = {},
  ): Promise<VerificationResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const chain = await this.load_manifest_chain(ctx, snapshot_id);
      const entries = merge_snapshot_entries(chain);
      const { items, unverifiable } = collect_check_items(entries);
      const failed = await this.check_all_items(ctx, items, options.fast === true);
      return {
        snapshot_id,
        total_checked: items.length,
        passed: items.length - failed.length,
        failed,
        unverifiable,
        manifests_in_chain: chain.length,
      };
    } finally {
      ctx.destroy();
    }
  }

  /**
   * Loads the target manifest plus every older manifest of the same mailbox,
   * sorted newest-first -- the delta chain a restore of this snapshot draws
   * from. Delta manifests are not self-contained; verifying only the target
   * manifest would skip every object carried over from earlier runs.
   */
  private async load_manifest_chain(ctx: TenantContext, snapshot_id: string): Promise<Manifest[]> {
    const target = await this._manifests.find_by_snapshot(ctx, snapshot_id);
    if (!target) {
      throw new Error(`No manifest found for snapshot ${snapshot_id}`);
    }

    const all = await this._manifests.list_all_manifests(ctx);
    const older = all.filter(
      (m) =>
        m.snapshot_id !== target.snapshot_id &&
        m.owner_id === target.owner_id &&
        new Date(m.created_at).getTime() <= new Date(target.created_at).getTime(),
    );
    return [target, ...older].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }

  /** Checks every item and returns the identifiers that failed verification. */
  private async check_all_items(
    ctx: TenantContext,
    items: CheckItem[],
    fast: boolean,
  ): Promise<string[]> {
    const failed: string[] = [];
    for (const item of items) {
      const is_corrupt = fast
        ? !(await this.object_exists(ctx, item))
        : await this.is_item_corrupt(ctx, item);
      if (is_corrupt) {
        failed.push(item.id);
      }
    }
    return failed;
  }

  /** Existence-only probe for fast mode; any error counts as missing. */
  private async object_exists(ctx: TenantContext, item: CheckItem): Promise<boolean> {
    try {
      return await ctx.storage.exists(item.storage_key);
    } catch {
      return false;
    }
  }

  /**
   * Downloads, decrypts, and hashes a single object.
   * Returns true if it is missing, decryption fails (tampered), or the
   * checksum mismatches.
   */
  private async is_item_corrupt(ctx: TenantContext, item: CheckItem): Promise<boolean> {
    try {
      const exists = await ctx.storage.exists(item.storage_key);
      if (!exists) return true;

      const ciphertext = await ctx.storage.get(item.storage_key);
      const plaintext = ctx.decrypt(ciphertext);
      const actual_checksum = compute_sha256(plaintext);
      return is_checksum_mismatch(actual_checksum, item.checksum);
    } catch {
      return true;
    }
  }
}

/**
 * Flattens manifest entries into verifiable objects (message blob plus each
 * attachment), separating out entries that have no stored blob at all.
 */
function collect_check_items(entries: ManifestEntry[]): {
  items: CheckItem[];
  unverifiable: string[];
} {
  const items: CheckItem[] = [];
  const unverifiable: string[] = [];

  for (const entry of entries) {
    if (entry.storage_key === '') {
      unverifiable.push(entry.object_id);
    } else {
      items.push({ id: entry.object_id, storage_key: entry.storage_key, checksum: entry.checksum });
    }

    for (const att of entry.attachments ?? []) {
      const att_id = `${entry.object_id}/${att.attachment_id}`;
      if (att.storage_key === '') {
        unverifiable.push(att_id);
      } else {
        items.push({ id: att_id, storage_key: att.storage_key, checksum: att.checksum });
      }
    }
  }

  return { items, unverifiable };
}

/** Returns the SHA-256 hex digest of the given buffer. */
function compute_sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compares checksums in constant time when lengths match.
 * Returns true for any mismatch or malformed length.
 */
function is_checksum_mismatch(actual_checksum: string, expected_checksum: string): boolean {
  if (actual_checksum.length !== expected_checksum.length) {
    return true;
  }

  const actual = Buffer.from(actual_checksum, 'utf8');
  const expected = Buffer.from(expected_checksum, 'utf8');
  return !timingSafeEqual(actual, expected);
}
