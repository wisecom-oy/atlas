/** The bucket a tenant's data is read from and written to. */
export interface ResolvedBucket {
  readonly name: string;
  /**
   * True when the name came from configuration (`ATLAS_S3_BUCKET`, a profile's `bucket`, or the
   * SDK's `s3Bucket`) rather than being derived as `atlas-<tenant_id>`. A configured bucket is
   * never created: a missing one is a configuration error.
   */
  readonly configured: boolean;
}

/**
 * Names the bucket for a tenant. Every S3 path asks this port, so a configured override and the
 * tenant it belongs to are decided in one place.
 */
export interface BucketNameResolver {
  /**
   * Returns the tenant's bucket.
   *
   * @throws ConfigError when the run's override belongs to another tenant, or when profiles name
   * different buckets for the same tenant.
   */
  resolve(tenant_id: string): ResolvedBucket;
}
