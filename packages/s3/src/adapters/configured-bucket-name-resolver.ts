import type { BucketSelection } from '@wisecom/atlas-core';
import type { BucketNameResolver, ResolvedBucket } from '@wisecom/atlas-types';
import { resolve_tenant_bucket } from '@/adapters/tenant-bucket-name';

/**
 * Names tenant buckets from the container's configuration. One instance per container, bound as
 * a constant, so the tenant context factory, the storage check, the storage inventory and SDK
 * validation all resolve the same name for the same tenant.
 */
export class ConfiguredBucketNameResolver implements BucketNameResolver {
  constructor(private readonly _selection: BucketSelection | undefined) {}

  /** Returns the tenant's bucket; see {@link resolve_tenant_bucket} for the rules. */
  resolve(tenant_id: string): ResolvedBucket {
    return resolve_tenant_bucket(this._selection, tenant_id);
  }
}
