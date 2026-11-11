import type { ObjectStorage, StorageTarget } from '@wisecom/atlas-types';
import { AtlasError } from '@wisecom/atlas-types';
import { logger } from '@/utils/logger';
import {
  DEK_META_KEY,
  create_dek_if_absent,
  replace_dek_if_unchanged,
} from '@/services/replication/conditional-dek-write';

/**
 * Thrown when replacing the primary's DEK could destroy existing ciphertext.
 *
 * Carries `ATLAS_KEY_CONFLICT` so the CLI exits in its own category and SDK callers can branch on
 * the code. Rerunning is refused the same way until an operator purges the primary (issue #659).
 */
export class DekOverwriteRefusedError extends AtlasError {
  constructor(tenant_id: string) {
    super(
      'ATLAS_KEY_CONFLICT',
      `Refusing to replace the encryption key of tenant ${tenant_id}: the primary bucket ` +
        `holds a key AND other objects, so the key may protect existing backups. ` +
        `Overwriting it would make that data permanently undecryptable. If the primary's ` +
        `content is disposable, purge the tenant (atlas delete --purge) and rerun ` +
        `rehydration into the empty bucket.`,
    );
  }
}

/**
 * Rehydration copies ciphertext encrypted with the source DEK, so the primary
 * must hold that exact DEK. Copies it when the primary has none; replaces an
 * existing one only when the primary bucket provably contains nothing but the
 * auto-generated key itself (the only object a fresh bucket holds). Anything
 * else aborts with DekOverwriteRefusedError.
 *
 * The emptiness check lists the whole bucket (2 keys suffice) instead of
 * known data prefixes: prefix knowledge went stale once before when OneDrive
 * and SharePoint added their own layouts, silently misclassifying data-bearing
 * primaries as empty (issue #26). A whole-bucket check is immune to new
 * domains by construction.
 *
 * Both writes are conditional, so a key another run stores between the checks
 * and the write is never replaced: the write is refused and surfaces as
 * DekWriteConflictError (issue #639).
 */
export async function ensure_source_dek_on_primary(
  primary: StorageTarget,
  source: StorageTarget,
  tenant_id: string,
): Promise<void> {
  const source_dek_blob = await read_source_dek(source, tenant_id);
  if (source_dek_blob === undefined) return;

  const primary_ctx = await primary.create_context(tenant_id);
  try {
    await install_source_dek(primary_ctx.storage, source_dek_blob, tenant_id);
  } finally {
    primary_ctx.destroy();
  }
}

/** Creates, keeps, or replaces the primary DEK so it matches the source blob. */
async function install_source_dek(
  storage: ObjectStorage,
  source_dek_blob: Buffer,
  tenant_id: string,
): Promise<void> {
  if (!(await storage.exists(DEK_META_KEY))) {
    await create_dek_if_absent(storage, source_dek_blob, tenant_id);
    return;
  }

  // The ETag is read before the emptiness check, so the replacement below is
  // refused if the key changes at any point after the bucket was judged empty.
  const primary_dek = await storage.get_with_etag(DEK_META_KEY);
  if (primary_dek.data.equals(source_dek_blob)) return;

  await assert_bucket_holds_only_the_dek(storage, tenant_id);

  logger.info(
    `Tenant ${tenant_id}: replacing the auto-generated key on the empty primary with the source key`,
  );
  await replace_dek_if_unchanged(storage, source_dek_blob, primary_dek.etag, tenant_id);
}

/** Throws DekOverwriteRefusedError unless the DEK is the bucket's only object. */
async function assert_bucket_holds_only_the_dek(
  storage: ObjectStorage,
  tenant_id: string,
): Promise<void> {
  const keys = await storage.list('', 2);
  const only_the_dek = keys.length === 1 && keys[0] === DEK_META_KEY;
  if (!only_the_dek) throw new DekOverwriteRefusedError(tenant_id);
}

/**
 * Reads the source DEK blob, or undefined when the source holds no key.
 *
 * Split out so the context lives exactly as long as the read. Both contexts used
 * to be created inline with no `try`, and this function has five exits, so the
 * passphrase buffers behind them were never zeroed on any of them (issue #200).
 */
async function read_source_dek(
  source: StorageTarget,
  tenant_id: string,
): Promise<Buffer | undefined> {
  const source_ctx = await source.create_context(tenant_id);
  try {
    if (!(await source_ctx.storage.exists(DEK_META_KEY))) return undefined;
    return await source_ctx.storage.get(DEK_META_KEY);
  } finally {
    source_ctx.destroy();
  }
}
