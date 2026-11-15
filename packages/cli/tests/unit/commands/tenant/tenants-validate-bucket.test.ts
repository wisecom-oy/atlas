import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { register_tenants_command } from '@/commands/tenant/tenants.command';

// Issue #768: `tenants validate` sends HeadBucket to each validated profile's own bucket, and
// ATLAS_S3_BUCKET reaches the selected profile only.

vi.mock('dotenv', () => ({ config: vi.fn() }));
vi.mock('@azure/identity', () => ({
  ClientSecretCredential: function () {
    return { getToken: vi.fn(async () => ({ token: 'fake' })) };
  },
}));

const s3_mocks = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
vi.mock('@wisecom/atlas-s3', async (import_original) => ({
  ...(await import_original<Record<string, unknown>>()),
  create_s3_client: vi.fn(() => ({ send: s3_mocks.send, destroy: s3_mocks.destroy })),
}));

const mocks = vi.hoisted(() => ({
  read_secure_config: vi.fn(),
  read_env_overrides: vi.fn(),
  try_load_config_file: vi.fn(),
}));
vi.mock('@wisecom/atlas-core', async (import_original) => ({
  ...(await import_original<Record<string, unknown>>()),
  ...mocks,
}));

const CLIENT = '00000000-0000-0000-0000-000000000002';
const SECRET = 'FAKE-client-secret';
const PROD = { tenant_id: '00000000-0000-0000-0000-000000000001', client_id: CLIENT };
const DR = { tenant_id: 'contoso.onmicrosoft.com', client_id: CLIENT };
const S3 = {
  s3_endpoint: 'https://s3.example.invalid',
  s3_access_key: 'FAKE-access-key-id',
  s3_secret_key: 'FAKE-s3-secret-do-not-use',
};

let output: string[];

function run(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  program.option('--profile <name>');
  register_tenants_command(program);
  return program.parseAsync(['tenants', ...args], { from: 'user' });
}

function probed_buckets(): string[] {
  return s3_mocks.send.mock.calls.map(
    ([command]) => (command as { input: { Bucket: string } }).input.Bucket,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  output = [];
  const capture = (...parts: unknown[]): void => {
    output.push(parts.map(String).join(' '));
  };
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
  mocks.try_load_config_file.mockReturnValue({});
  mocks.read_env_overrides.mockReturnValue({});
  mocks.read_secure_config.mockReturnValue({
    ...S3,
    tenants: {
      prod: { ...PROD, client_secret: SECRET, bucket: 'prod-copy' },
      dr: { ...DR, client_secret: SECRET },
    },
    active_tenant: 'prod',
  });
  s3_mocks.send.mockResolvedValue({});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('atlas tenants validate bucket (issue #768)', () => {
  it("probes each profile's own bucket", async () => {
    await run(['validate', '--all']);

    expect(probed_buckets()).toEqual([`atlas-${DR.tenant_id}`, 'prod-copy']);
    expect(output.join('\n')).toContain('S3 [prod]: effective bucket "prod-copy" (configured)');
    expect(process.exitCode).toBeUndefined();
  });

  it('applies ATLAS_S3_BUCKET to the selected profile only', async () => {
    vi.stubEnv('ATLAS_S3_BUCKET', 'prod-replica');

    await run(['validate', '--all']);

    expect(probed_buckets()).toEqual([`atlas-${DR.tenant_id}`, 'prod-replica']);
  });

  it('fails when a configured bucket is missing', async () => {
    s3_mocks.send.mockRejectedValue(Object.assign(new Error('NotFound'), { name: 'NotFound' }));

    await run(['validate', 'prod']);

    expect(process.exitCode).toBe(1);
    expect(output.join('\n')).toMatch(/configured bucket "prod-copy" does not exist/);
  });
});
