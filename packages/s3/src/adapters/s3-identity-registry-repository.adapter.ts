import { injectable } from 'inversify';
import type {
  IdentityRegistry,
  IdentityRegistryRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { load_encrypted_json } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';

const REGISTRY_KEY = 'identity-registry.json';

/**
 * Stores the tenant identity registry as a single encrypted JSON object in S3.
 * Key layout: identity-registry.json (tenant-level, no owner prefix).
 */
@injectable()
export class S3IdentityRegistryRepository implements IdentityRegistryRepository {
  /** Loads the registry; undefined only if none exists, throws if it exists and cannot be read. */
  async load(ctx: TenantContext): Promise<IdentityRegistry | undefined> {
    return load_encrypted_json<IdentityRegistry>(ctx, REGISTRY_KEY);
  }

  async save(ctx: TenantContext, registry: IdentityRegistry): Promise<void> {
    const json = Buffer.from(JSON.stringify(registry));
    const encrypted = ctx.encrypt(json, REGISTRY_KEY);
    await ctx.storage.put(REGISTRY_KEY, encrypted);
  }
}
