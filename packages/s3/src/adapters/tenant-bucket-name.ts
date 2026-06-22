/** Bucket name convention: atlas-{tenant_id}. */
export function tenant_bucket_name(tenant_id: string): string {
  return `atlas-${tenant_id}`;
}
