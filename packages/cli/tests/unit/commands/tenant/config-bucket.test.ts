import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { ConfigError } from '@wisecom/atlas-types';
import { register_config_command } from '@/commands/tenant/config.command';

// Issue #768: `config validate` sends HeadBucket to the effective bucket, and the bucket is never
// a shared setting.

vi.mock('dotenv', () => ({ config: vi.fn() }));

const s3_mocks = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
vi.mock('@wisecom/atlas-s3', async (import_original) => ({
  ...(await import_original<Record<string, unknown>>()),
  create_s3_client: vi.fn(() => ({ send: s3_mocks.send, destroy: s3_mocks.destroy })),
}));

const mocks = vi.hoisted(() => {
  const read_secure_config = vi.fn();
  const write_secure_config = vi.fn();
  return {
    read_secure_config,
    write_secure_config,
    update_secure_config: vi.fn((mutate: (current: object) => object) => {
      const next = mutate(read_secure_config() ?? {});
      write_secure_config(next);
      return next;
    }),
    read_env_overrides: vi.fn(),
    try_load_config_file: vi.fn(),
    secure_config_dir: vi.fn(() => '/tmp/fake-atlas'),
  };
});
vi.mock('@wisecom/atlas-core', async (import_original) => ({
  ...(await import_original<Record<string, unknown>>()),
  ...mocks,
}));

const TENANT = '00000000-0000-0000-0000-000000000001';
const PROFILE = {
  tenant_id: TENANT,
  client_id: '00000000-0000-0000-0000-000000000002',
  client_secret: 'FAKE-client-secret',
};
const S3 = {
  s3_endpoint: 'https://s3.example.invalid',
  s3_access_key: 'FAKEACCESSKEYID12345',
  s3_secret_key: 'FAKE-s3-secret-key',
};

let output: string[];

function run(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  program.option('--profile <name>');
  register_config_command(program);
  return program.parseAsync(['config', ...args], { from: 'user' });
}

function store(profile: object, extra: object = {}): void {
  mocks.read_secure_config.mockReturnValue({
    ...S3,
    ...extra,
    tenants: { prod: profile },
    active_tenant: 'prod',
  });
}

function sent(): { name: string; bucket: string }[] {
  return s3_mocks.send.mock.calls.map(([command]) => ({
    name: (command as object).constructor.name,
    bucket: (command as { input: { Bucket: string } }).input.Bucket,
  }));
}

function not_found(): Error {
  return Object.assign(new Error('NotFound'), { name: 'NotFound' });
}

beforeEach(() => {
  vi.clearAllMocks();
  output = [];
  const capture = (...parts: unknown[]): void => {
    output.push(parts.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'info').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  mocks.try_load_config_file.mockReturnValue({});
  mocks.read_env_overrides.mockReturnValue({});
  s3_mocks.send.mockResolvedValue({});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('atlas config validate (issue #768)', () => {
  it('sends HeadBucket to the derived bucket and names it', async () => {
    store(PROFILE);

    await run(['validate']);

    expect(sent()).toEqual([{ name: 'HeadBucketCommand', bucket: `atlas-${TENANT}` }]);
    expect(output.join('\n')).toContain(
      `effective bucket "atlas-${TENANT}" (derived from the tenant ID)`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("sends HeadBucket to the profile's bucket", async () => {
    store({ ...PROFILE, bucket: 'prod-copy' });

    await run(['validate']);

    expect(sent()).toEqual([{ name: 'HeadBucketCommand', bucket: 'prod-copy' }]);
    expect(output.join('\n')).toContain('effective bucket "prod-copy" (configured)');
  });

  it('lets ATLAS_S3_BUCKET win over the profile bucket', async () => {
    store({ ...PROFILE, bucket: 'prod-copy' });
    vi.stubEnv('ATLAS_S3_BUCKET', 'prod-replica');

    await run(['validate']);

    expect(sent()).toEqual([{ name: 'HeadBucketCommand', bucket: 'prod-replica' }]);
  });

  it('fails on a missing configured bucket, which Atlas never creates', async () => {
    store({ ...PROFILE, bucket: 'prod-copy' });
    s3_mocks.send.mockRejectedValue(not_found());

    await run(['validate']);

    expect(process.exitCode).toBe(1);
    expect(output.join('\n')).toMatch(/configured bucket "prod-copy" does not exist/);
  });

  it('passes on a missing derived bucket, which the first backup creates', async () => {
    store(PROFILE);
    s3_mocks.send.mockRejectedValue(not_found());

    await run(['validate']);

    expect(process.exitCode).toBeUndefined();
    expect(output.join('\n')).toMatch(/the first backup creates it/);
  });

  it('fails on ATLAS_S3_BUCKET without a tenant ID instead of falling back to ListBuckets', async () => {
    mocks.read_secure_config.mockReturnValue({ ...S3 });
    vi.stubEnv('ATLAS_S3_BUCKET', 'unbound-copy');

    await run(['validate']);

    expect(process.exitCode).toBe(1);
    expect(s3_mocks.send).not.toHaveBeenCalled();
    expect(output.join('\n')).toMatch(/no tenant ID is configured to bind it to/);
  });

  it('refuses a top-level bucket in the store', async () => {
    store(PROFILE, { bucket: 'shared-copy' });

    await expect(run(['validate'])).rejects.toBeInstanceOf(ConfigError);
    expect(s3_mocks.send).not.toHaveBeenCalled();
  });
});

describe('atlas config set bucket (issue #768)', () => {
  it.each(['bucket', 's3.bucket'])(
    'refuses "%s" as a shared key, pointing at the profile',
    async (key) => {
      store(PROFILE);

      await expect(run(['set', key, 'shared-copy'])).rejects.toThrow(/tenants add .* --bucket/);
      expect(mocks.write_secure_config).not.toHaveBeenCalled();
    },
  );
});
