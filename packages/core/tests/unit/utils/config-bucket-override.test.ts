import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { ConfigError } from '@wisecom/atlas-types';
import { load_config } from '@/utils/config';
import { build_bucket_selection } from '@/utils/bucket-override';
import { find_profile } from '@/utils/tenant-profiles';

vi.mock('node:fs');
vi.mock('node:os');
vi.mock('dotenv', () => ({ config: vi.fn() }));

// Issue #768: a bucket override is bound to the tenant it was configured for.

const SHARED = {
  s3_endpoint: 'http://localhost:9000',
  s3_access_key: 'access',
  s3_secret_key: 'secret-key',
  encryption_passphrase: 'passphrase',
};
const PROD = { tenant_id: 'tid-prod', client_id: 'cid-prod', client_secret: 'secret-prod' };
const DR = { tenant_id: 'tid-dr', client_id: 'cid-dr', client_secret: 'secret-dr' };

/** Serves `contents` as ./atlas.config.json; the encrypted store is absent. */
function config_file(contents: object): void {
  vi.mocked(os.homedir).mockReturnValue('/home/testuser');
  vi.mocked(fs.existsSync).mockImplementation(
    (p) => String(p).includes('atlas.config.json') && !String(p).includes('.atlas'),
  );
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(contents));
}

describe('bucket override in load_config', () => {
  const original_env = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...original_env };
    for (const key of Object.keys(process.env))
      if (key.startsWith('ATLAS_')) delete process.env[key];
  });

  afterEach(() => {
    process.env = original_env;
  });

  it('adds nothing when no override is configured, so existing setups load as before', () => {
    config_file({ ...SHARED, tenants: { prod: PROD, dr: DR }, active_tenant: 'prod' });

    const config = load_config();

    expect(config).not.toHaveProperty('s3_bucket');
    expect(config).toEqual({ ...SHARED, ...PROD, s3_region: 'us-east-1' });
  });

  it("binds the selected profile's bucket to that profile's tenant", () => {
    config_file({ ...SHARED, tenants: { prod: { ...PROD, bucket: 'prod-copy' }, dr: DR } });

    expect(load_config({ profile: 'prod' }).s3_bucket).toEqual({
      run: {
        tenant_id: 'tid-prod',
        bucket: 'prod-copy',
        exclusive: false,
        set_by: 'tenant profile "prod"',
      },
      profiles: [
        { tenant_id: 'tid-dr', bucket: undefined },
        { tenant_id: 'tid-prod', bucket: 'prod-copy' },
      ],
    });
  });

  it('lets ATLAS_S3_BUCKET win over the profile bucket, exclusive to the run', () => {
    config_file({ ...SHARED, tenants: { prod: { ...PROD, bucket: 'prod-copy' } } });
    process.env['ATLAS_S3_BUCKET'] = 'prod-replica';

    expect(load_config({ profile: 'prod' }).s3_bucket?.run).toEqual({
      tenant_id: 'tid-prod',
      bucket: 'prod-replica',
      exclusive: true,
      set_by: 'ATLAS_S3_BUCKET',
    });
  });

  it('drops the profile bucket when ATLAS_TENANT_ID points the run at another tenant', () => {
    config_file({ ...SHARED, tenants: { prod: { ...PROD, bucket: 'prod-copy' } } });
    process.env['ATLAS_TENANT_ID'] = 'tid-other';
    process.env['ATLAS_CLIENT_ID'] = 'cid-other';
    process.env['ATLAS_CLIENT_SECRET'] = 'secret-other';

    const selection = load_config({ profile: 'prod' }).s3_bucket;

    expect(selection?.run).toMatchObject({ tenant_id: 'tid-other', bucket: undefined });
    expect(selection?.profiles).toEqual([{ tenant_id: 'tid-prod', bucket: 'prod-copy' }]);
  });

  it.each([
    ['bucket', { bucket: 'shared-copy' }],
    ['s3_bucket', { s3_bucket: 'shared-copy' }],
  ])('refuses a top-level %s, which would apply to every profile', (_label, top_level) => {
    config_file({ ...SHARED, ...top_level, tenants: { prod: PROD } });

    expect(() => load_config()).toThrow(ConfigError);
    expect(() => load_config()).toThrow(/would apply to every tenant profile/);
  });

  it('refuses an override that is not a valid bucket name, naming its source', () => {
    config_file({ ...SHARED, tenants: { prod: PROD } });
    process.env['ATLAS_S3_BUCKET'] = 'Not_A_Bucket';

    expect(() => load_config({ profile: 'prod' })).toThrow(
      /ATLAS_S3_BUCKET names "Not_A_Bucket", which is not a valid S3 bucket name/,
    );
  });
});

describe('build_bucket_selection', () => {
  it('pairs the env bucket with the run tenant even without a stored profile', () => {
    expect(
      build_bucket_selection({
        run_tenant_id: 'tid-env',
        profile_name: 'default',
        env_bucket: 'env-copy',
        profiles: [],
      }),
    ).toEqual({
      run: { tenant_id: 'tid-env', bucket: 'env-copy', exclusive: true, set_by: 'ATLAS_S3_BUCKET' },
      profiles: [],
    });
  });

  it('matches the selected profile to the run tenant case-insensitively', () => {
    const selection = build_bucket_selection({
      run_tenant_id: 'Contoso.onmicrosoft.com',
      profile_name: 'prod',
      selected: { tenant_id: 'contoso.onmicrosoft.com', bucket: 'contoso-copy' },
      profiles: [{ tenant_id: 'contoso.onmicrosoft.com', bucket: 'contoso-copy' }],
    });

    expect(selection?.run.bucket).toBe('contoso-copy');
  });

  it('skips profiles with no tenant ID, since a bucket cannot be bound to nothing', () => {
    const selection = build_bucket_selection({
      run_tenant_id: 'tid-prod',
      profile_name: 'prod',
      profiles: [{ bucket: 'orphan-copy' }, { tenant_id: 'tid-dr', bucket: 'dr-copy' }],
    });

    expect(selection?.profiles).toEqual([{ tenant_id: 'tid-dr', bucket: 'dr-copy' }]);
  });
});

describe('find_profile and the bucket (issue #768)', () => {
  const file = { tenants: { prod: { ...PROD, bucket: 'prod-copy' } } };

  it("drops the file's bucket when the store moves the profile to another tenant", () => {
    const secure = { tenants: { prod: { ...DR } } };

    expect(find_profile('prod', file, secure)).toEqual(DR);
  });

  it("keeps the file's bucket when the store copy names the same tenant", () => {
    const secure = { tenants: { prod: { client_secret: 'rotated', tenant_id: 'TID-PROD' } } };

    expect(find_profile('prod', file, secure)?.bucket).toBe('prod-copy');
  });

  it("keeps the store's own bucket when it names one", () => {
    const secure = { tenants: { prod: { ...DR, bucket: 'dr-copy' } } };

    expect(find_profile('prod', file, secure)?.bucket).toBe('dr-copy');
  });
});
