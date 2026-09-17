import { randomUUID } from 'node:crypto';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, NotFoundError, StorageError, WrongPassphraseError } from '@wisecom/atlas-types';
import { createAtlasInstance } from '@/atlas-instance.adapter';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  get_access_token: vi.fn(),
  create_context: vi.fn(),
  create_readonly_context: vi.fn(),
  destroy_context: vi.fn(),
  log: vi.fn(),
}));

vi.mock('@/container', () => ({
  create_container_from_config: () => ({
    get: (token: symbol) => {
      switch (token.description) {
        case 'S3Client':
          return { send: mocks.send };
        case 'GraphAuthProvider':
          return { getAccessToken: mocks.get_access_token };
        case 'TenantContextFactory':
          return {
            create: mocks.create_context,
            create_readonly: mocks.create_readonly_context,
          };
        default:
          return {};
      }
    },
  }),
}));

function create_instance() {
  return createAtlasInstance({
    tenantId: 'tenant-example',
    clientId: 'client-example',
    clientSecret: '<redacted>',
    s3Endpoint: 'https://storage.example.com',
    s3AccessKey: '<redacted>',
    s3SecretKey: '<redacted>',
    encryptionPassphrase: '<redacted>'.repeat(2),
    logger: {
      debug: mocks.log,
      info: mocks.log,
      warn: mocks.log,
      error: mocks.log,
    },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.send.mockResolvedValue({});
  mocks.get_access_token.mockResolvedValue(randomUUID());
  mocks.create_readonly_context.mockRejectedValue(
    new NotFoundError('No backups found for tenant tenant-example'),
  );
});

describe('atlas.validate', () => {
  it('is opt-in, checks the bucket and optional key before token issuance, and exposes no token', async () => {
    const atlas = create_instance();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.get_access_token).not.toHaveBeenCalled();

    const head = Promise.withResolvers<object>();
    mocks.send.mockReturnValueOnce(head.promise);
    const validation = atlas.validate();
    expect(mocks.get_access_token).not.toHaveBeenCalled();
    head.resolve({});

    await expect(validation).resolves.toBeUndefined();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const command = mocks.send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(HeadBucketCommand);
    expect(command.input).toEqual({ Bucket: 'atlas-tenant-example' });
    expect(mocks.get_access_token).toHaveBeenCalledTimes(1);
    expect(mocks.create_readonly_context).toHaveBeenCalledTimes(1);
    expect(mocks.create_context).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it('passes for a fresh tenant whose wrapped key does not exist yet', async () => {
    await expect(create_instance().validate()).resolves.toBeUndefined();

    expect(mocks.create_readonly_context).toHaveBeenCalledTimes(1);
    expect(mocks.create_context).not.toHaveBeenCalled();
    expect(mocks.get_access_token).toHaveBeenCalledTimes(1);
  });

  it('fails specifically on a wrong existing passphrase and does not acquire a Graph token', async () => {
    const cause = new WrongPassphraseError('The configured passphrase does not open this key');
    mocks.create_readonly_context.mockRejectedValue(cause);

    const error = await create_instance()
      .validate()
      .catch((error: unknown) => error);

    expect(error).toBe(cause);
    expect(mocks.create_readonly_context).toHaveBeenCalledTimes(1);
    expect(mocks.create_context).not.toHaveBeenCalled();
    expect(mocks.get_access_token).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it('destroys the temporary context after an existing key opens', async () => {
    mocks.create_readonly_context.mockResolvedValue({ destroy: mocks.destroy_context });

    await expect(create_instance().validate()).resolves.toBeUndefined();

    expect(mocks.destroy_context).toHaveBeenCalledTimes(1);
    expect(mocks.get_access_token).toHaveBeenCalledTimes(1);
  });

  it('reports S3 denial as a storage failure and does not acquire a Graph token', async () => {
    const cause = Object.assign(new Error(randomUUID()), { name: 'AccessDenied' });
    mocks.send.mockRejectedValue(cause);

    const error = await create_instance()
      .validate()
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ code: 'ATLAS_STORAGE_FAILURE', cause });
    expect((error as Error).message).not.toContain(cause.message);
    expect(mocks.get_access_token).not.toHaveBeenCalled();
    expect(mocks.create_context).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it('does not provision a missing bucket', async () => {
    const cause = Object.assign(new Error(), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    mocks.send.mockRejectedValue(cause);

    const error = await create_instance()
      .validate()
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ code: 'ATLAS_STORAGE_FAILURE', cause });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]![0]).toBeInstanceOf(HeadBucketCommand);
    expect(mocks.create_context).not.toHaveBeenCalled();
    expect(mocks.get_access_token).not.toHaveBeenCalled();
  });

  it('distinguishes Graph token rejection from storage failure without exposing diagnostics', async () => {
    const cause = new Error(randomUUID());
    mocks.get_access_token.mockRejectedValue(cause);

    const error = await create_instance()
      .validate()
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: 'ATLAS_AUTH_DENIED', cause });
    expect((error as Error).message).not.toContain(cause.message);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.create_context).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });
});
