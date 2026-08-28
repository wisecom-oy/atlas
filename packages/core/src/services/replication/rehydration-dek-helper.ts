import type { StorageTarget } from '@wisecom/atlas-types';
import { logger } from '@/utils/logger';

const DEK_META_KEY = '_meta/dek.enc';

/** Thrown when replacing the primary's DEK could destroy existing ciphertext. */
export class DekOverwriteRefusedError extends Error {
  constructor(tenant_id: string) {
    super(
      `Refusing to replace the encryption key of tenant ${tenant_id}: the primary bucket ` +
        `holds a key AND other objects, so the key may protect existing backups. ` +
        `Overwriting it would make that data permanently undecryptable. If the primary's ` +
        `content is disposable, purge the tenant (atlas delete --purge) and rerun ` +
        `rehydration into the empty bucket.`,
    );
    this.name = 'DekOverwriteRefusedError';
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
    const primary_has_dek = await primary_ctx.storage.exists(DEK_META_KEY);

    if (!primary_has_dek) {
      await primary_ctx.storage.put(DEK_META_KEY, source_dek_blob);
      return;
    }

    const primary_dek_blob = await primary_ctx.storage.get(DEK_META_KEY);
    if (primary_dek_blob.equals(source_dek_blob)) return;

    const keys = await primary_ctx.storage.list('', 2);
    const only_the_dek = keys.length === 1 && keys[0] === DEK_META_KEY;
    if (!only_the_dek) throw new DekOverwriteRefusedError(tenant_id);

    logger.info(
      `Tenant ${tenant_id}: replacing the auto-generated key on the empty primary with the source key`,
    );
    await primary_ctx.storage.put(DEK_META_KEY, source_dek_blob);
  } finally {
    primary_ctx.destroy();
  }
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
