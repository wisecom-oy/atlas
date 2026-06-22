import type { StorageTarget } from '@atlas/types';

const DEK_META_KEY = '_meta/dek.enc';

/**
 * For rehydration to an empty primary, the TenantContextFactory auto-generates
 * a new random DEK on first access. This would conflict with the source's DEK.
 *
 * This helper checks if primary has a DEK. If not, it copies the source's DEK.
 * If primary has a DEK but no manifests (auto-generated on an empty bucket),
 * it overwrites with the source's DEK so rehydration can proceed.
 */
export async function ensure_source_dek_on_primary(
  primary: StorageTarget,
  source: StorageTarget,
  tenant_id: string,
): Promise<void> {
  const source_ctx = await source.create_context(tenant_id);
  const source_has_dek = await source_ctx.storage.exists(DEK_META_KEY);
  if (!source_has_dek) return;

  const primary_ctx = await primary.create_context(tenant_id);
  const primary_has_dek = await primary_ctx.storage.exists(DEK_META_KEY);

  if (!primary_has_dek) {
    const source_dek_blob = await source_ctx.storage.get(DEK_META_KEY);
    await primary_ctx.storage.put(DEK_META_KEY, source_dek_blob);
    return;
  }

  const has_manifests = (await primary_ctx.storage.list('manifests/')).length > 0;
  if (has_manifests) return;

  const source_dek_blob = await source_ctx.storage.get(DEK_META_KEY);
  await primary_ctx.storage.put(DEK_META_KEY, source_dek_blob);
}
