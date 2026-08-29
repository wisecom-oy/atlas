import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { CONFIG_KEYS } from '@wisecom/atlas-core';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { register_config_command } from '@/commands/config.command';

vi.mock('dotenv', () => ({ config: vi.fn() }));
vi.mock('@azure/identity', () => ({
  ClientSecretCredential: function () {
    return { getToken: vi.fn().mockResolvedValue({ token: 'fake' }) };
  },
}));
vi.mock('@wisecom/atlas-s3', () => ({ create_s3_client: vi.fn() }));

const mocks = vi.hoisted(() => ({
  read_secure_config: vi.fn(),
  write_secure_config: vi.fn(),
  read_env_overrides: vi.fn(),
  try_load_config_file: vi.fn(),
  secure_config_dir: vi.fn(() => '/tmp/fake-atlas'),
}));

// Real CONFIG_KEYS, find_config_key and mask_secret: the point is to drive the
// assertions from the shipped key table, not from a copy of it. Only the store
// and environment readers are replaced, so no test touches ~/.atlas/config.enc.
vi.mock('@wisecom/atlas-core', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, ...mocks };
});

/** Obviously fake, and long enough that masking cannot be mistaken for truncation. */
const FAKE_VALUES: Record<string, string> = {
  'tenant.id': '00000000-0000-0000-0000-000000000001',
  'client.id': '00000000-0000-0000-0000-000000000002',
  'client.secret': 'FAKE-client-secret-do-not-use-9Q7xVt',
  's3.endpoint': 'https://s3.example.invalid',
  's3.access-key': 'FAKEACCESSKEYID12345',
  's3.secret-key': 'FAKE-s3-secret-access-key-do-not-use-8Zk2',
  's3.region': 'us-east-1',
  'encryption.passphrase': 'FAKE-passphrase-do-not-use-4Wm9',
};

function full_config(): Partial<AtlasConfig> {
  const config: Record<string, string> = {};
  for (const spec of CONFIG_KEYS) {
    config[spec.field] = FAKE_VALUES[spec.key]!;
  }
  return config as Partial<AtlasConfig>;
}

let output: string[];

function run(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  register_config_command(program);
  return program.parseAsync(['config', ...args], { from: 'user' });
}

beforeEach(() => {
  output = [];
  const capture = (...parts: unknown[]): void => {
    output.push(parts.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);

  mocks.try_load_config_file.mockReturnValue({});
  mocks.read_env_overrides.mockReturnValue({});
  mocks.read_secure_config.mockReturnValue(full_config());
});

afterEach(() => {
  vi.restoreAllMocks();
});

const secret_keys = CONFIG_KEYS.filter((spec) => spec.secret);
const plain_keys = CONFIG_KEYS.filter((spec) => !spec.secret);

describe('atlas config never prints a secret in full', () => {
  it.each(secret_keys.map((spec) => spec.key))('config list masks %s', async (key) => {
    await run(['list']);

    const full_value = FAKE_VALUES[key]!;
    expect(output.join('\n')).not.toContain(full_value);
  });

  it.each(secret_keys.map((spec) => spec.key))('config get masks %s', async (key) => {
    await run([key]);

    const full_value = FAKE_VALUES[key]!;
    expect(output.join('\n')).not.toContain(full_value);
    // Something was printed: an empty output would pass the check above while
    // telling the operator nothing.
    expect(output.join('').length).toBeGreaterThan(0);
  });

  it.each(plain_keys.map((spec) => spec.key))('config get prints %s in full', async (key) => {
    await run([key]);

    // Distinguishes masking from blanket redaction: a non-secret must survive.
    expect(output.join('\n')).toContain(FAKE_VALUES[key]!);
  });

  it('lists every key, so a masked value is still reported as set', async () => {
    await run(['list']);

    const listed = output.join('\n');
    for (const spec of CONFIG_KEYS) {
      expect(listed).toContain(spec.key);
    }
    expect(listed).not.toContain('<unset>');
  });
});

describe('credential-shaped keys carry the secret flag', () => {
  // The guarantee "secrets are never printed" holds only while every credential
  // entry in CONFIG_KEYS is flagged. A key added later without it prints a
  // client secret to stdout and into CI logs, which is what #174 and #175 were.
  const CREDENTIAL_PATTERN = /secret|passphrase|password|credential|token/i;

  it.each(CONFIG_KEYS.map((spec) => [spec.key, spec.field, spec.secret] as const))(
    '%s is flagged correctly for its name',
    (key, field, secret) => {
      const looks_like_credential =
        CREDENTIAL_PATTERN.test(key) || CREDENTIAL_PATTERN.test(String(field));
      if (looks_like_credential) {
        expect(secret, `${key} looks like a credential and must set secret: true`).toBe(true);
      }
    },
  );

  it('flags the three credential fields Atlas holds', () => {
    // Named explicitly as well as by pattern: a rename that dodges the regex
    // still has to fail something.
    const flagged = CONFIG_KEYS.filter((spec) => spec.secret).map((spec) => spec.field);

    expect(flagged).toContain('client_secret');
    expect(flagged).toContain('s3_secret_key');
    expect(flagged).toContain('encryption_passphrase');
  });

  it('does not flag an S3 access key ID, which is an identifier', () => {
    // Blanket flagging would pass every masking test above while making the
    // output useless, so the negative case is worth pinning.
    const access_key = CONFIG_KEYS.find((spec) => spec.field === 's3_access_key');

    expect(access_key?.secret).toBe(false);
  });
});
