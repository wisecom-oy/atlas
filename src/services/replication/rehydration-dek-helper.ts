import type { StorageTarget } from '@/ports/replication/storage-target.port';
import type { AtlasConfig } from '@/utils/config';
import { create_storage_target } from '@/adapters/storage-target.factory';

const DEK_META_KEY = '_meta/dek.enc';

/**
 * For rehydration to an empty primary, the TenantContextFactory auto-generates
 * a new random DEK on first access. This would conflict with the source's DEK.
 *
 * This helper uses raw S3 access (bypassing the factory) to check if primary
 * has a DEK. If not, it copies the source's DEK to primary BEFORE the factory
 * runs, so the factory loads the correct DEK instead of generating a new one.
 */
export async function ensure_source_dek_on_primary(
  config: AtlasConfig,
  source: StorageTarget,
  tenant_id: string,
): Promise<void> {
  const primary_raw = create_storage_target({
    s3_endpoint: config.s3_endpoint,
    s3_access_key: config.s3_access_key,
    s3_secret_key: config.s3_secret_key,
    s3_region: config.s3_region,
    encryption_passphrase: config.encryption_passphrase,
  });

  const primary_ctx = await primary_raw.create_context(tenant_id);
  const primary_has_dek = await primary_ctx.storage.exists(DEK_META_KEY);
  if (primary_has_dek) return;

  const source_ctx = await source.create_context(tenant_id);
  const source_has_dek = await source_ctx.storage.exists(DEK_META_KEY);
  if (!source_has_dek) return;

  const source_dek_blob = await source_ctx.storage.get(DEK_META_KEY);
  await primary_ctx.storage.put(DEK_META_KEY, source_dek_blob);
}
