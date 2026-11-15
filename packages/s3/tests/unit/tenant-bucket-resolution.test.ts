import { describe, it, expect } from 'vitest';
import type { BucketSelection } from '@wisecom/atlas-core';
import { ConfigError } from '@wisecom/atlas-types';
import { resolve_tenant_bucket, tenant_bucket_name } from '@/adapters/tenant-bucket-name';

// Issue #768: one resolver names every tenant bucket, and an override never crosses tenants.

const PROD = '11111111-2222-3333-4444-555555555555';
const DR = 'contoso.onmicrosoft.com';
const OTHER = 'fabrikam.onmicrosoft.com';

function selection(
  run: Partial<BucketSelection['run']>,
  profiles: BucketSelection['profiles'] = [],
): BucketSelection {
  return {
    run: { tenant_id: PROD, exclusive: false, set_by: 'tenant profile "prod"', ...run },
    profiles,
  };
}

describe('resolve_tenant_bucket', () => {
  it('derives atlas-<tenant_id> exactly as before when nothing is overridden', () => {
    expect(resolve_tenant_bucket(undefined, PROD)).toEqual({
      name: `atlas-${PROD}`,
      configured: false,
    });
    expect(resolve_tenant_bucket(undefined, DR)).toEqual({
      name: `atlas-${DR}`,
      configured: false,
    });
    expect(tenant_bucket_name(PROD)).toBe(`atlas-${PROD}`);
  });

  it('returns the override for the tenant it is bound to', () => {
    expect(resolve_tenant_bucket(selection({ bucket: 'prod-copy' }), PROD)).toEqual({
      name: 'prod-copy',
      configured: true,
    });
  });

  it('matches the bound tenant case-insensitively, but derives from the spelling asked for', () => {
    const upper = selection({ tenant_id: DR.toUpperCase(), bucket: undefined });

    expect(
      resolve_tenant_bucket(selection({ tenant_id: DR, bucket: 'dr-copy' }), DR.toUpperCase()),
    ).toEqual({ name: 'dr-copy', configured: true });
    expect(resolve_tenant_bucket(upper, DR).name).toBe(`atlas-${DR}`);
  });

  it('treats an override equal to the derived name as derived, so it may still be created', () => {
    expect(resolve_tenant_bucket(selection({ bucket: `atlas-${PROD}` }), PROD)).toEqual({
      name: `atlas-${PROD}`,
      configured: false,
    });
  });

  it('refuses any other tenant while an exclusive override is set, naming its source', () => {
    const exclusive = selection(
      { bucket: 'prod-copy', exclusive: true, set_by: 'ATLAS_S3_BUCKET' },
      [{ tenant_id: DR, bucket: 'dr-copy' }],
    );

    expect(() => resolve_tenant_bucket(exclusive, DR)).toThrow(ConfigError);
    expect(() => resolve_tenant_bucket(exclusive, OTHER)).toThrow(
      `ATLAS_S3_BUCKET names bucket "prod-copy" for tenant ${PROD} only, so this run refuses to ` +
        `open tenant ${OTHER}.`,
    );
  });

  it("gives another tenant its own profile's bucket, never the run's", () => {
    const by_profile = selection({ bucket: 'prod-copy' }, [
      { tenant_id: PROD, bucket: 'prod-copy' },
      { tenant_id: DR, bucket: 'dr-copy' },
      { tenant_id: OTHER },
    ]);

    expect(resolve_tenant_bucket(by_profile, DR)).toEqual({ name: 'dr-copy', configured: true });
    expect(resolve_tenant_bucket(by_profile, OTHER)).toEqual({
      name: `atlas-${OTHER}`,
      configured: false,
    });
    expect(resolve_tenant_bucket(by_profile, 'unknown-tenant').name).toBe('atlas-unknown-tenant');
  });

  it('lets the selected profile decide its own tenant over another profile of the same tenant', () => {
    // "prod" without a bucket and "prod-replica" pointing at the copy: running "prod" must not
    // read the copy just because another profile names one for the same tenant.
    const prod_run = selection({ bucket: undefined }, [
      { tenant_id: PROD },
      { tenant_id: PROD, bucket: 'prod-copy' },
    ]);

    expect(resolve_tenant_bucket(prod_run, PROD)).toEqual({
      name: `atlas-${PROD}`,
      configured: false,
    });
  });

  it('refuses another tenant whose profiles disagree on its bucket', () => {
    const ambiguous = selection({}, [{ tenant_id: DR }, { tenant_id: DR, bucket: 'dr-copy' }]);

    expect(() => resolve_tenant_bucket(ambiguous, DR)).toThrow(
      `Tenant profiles name different buckets for tenant ${DR}: atlas-${DR}, dr-copy.`,
    );
  });
});
