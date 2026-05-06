import { injectable } from 'inversify';
import type { IdentityRegistry, IdentityRegistryRepository, TenantContext } from '@atlas/types';

const REGISTRY_KEY = 'identity-registry.json';

/**
 * Stores the tenant identity registry as a single encrypted JSON object in S3.
 * Key layout: identity-registry.json (tenant-level, no owner prefix).
 */
@injectable()
export class S3IdentityRegistryRepository implements IdentityRegistryRepository {
  async load(ctx: TenantContext): Promise<IdentityRegistry | undefined> {
    try {
      const exists = await ctx.storage.exists(REGISTRY_KEY);
      if (!exists) return undefined;
      const encrypted = await ctx.storage.get(REGISTRY_KEY);
      const json = ctx.decrypt(encrypted);
      return JSON.parse(json.toString('utf-8')) as IdentityRegistry;
    } catch {
      return undefined;
    }
  }

  async save(ctx: TenantContext, registry: IdentityRegistry): Promise<void> {
    const json = Buffer.from(JSON.stringify(registry));
    const encrypted = ctx.encrypt(json);
    await ctx.storage.put(REGISTRY_KEY, encrypted);
  }
}
