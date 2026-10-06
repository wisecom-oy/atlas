import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, type StorageRequestEvent } from '@wisecom/atlas-types';
import { create_storage_target } from '@/adapters/storage-target.factory';
import { s3_error, start_fake_s3, type FakeS3 } from './fake-s3-server';

const PASSPHRASE = 'replica-passphrase-long-enough';

let fake: FakeS3 | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('replication target storage request events', () => {
  it('reports every request sent to the target under its targetId', async () => {
    // The bucket exists and holds no DEK yet, the state a fresh replica is in.
    fake = await start_fake_s3((req) =>
      req.method === 'HEAD' && req.url?.includes('_meta')
        ? s3_error(404, 'NotFound')
        : { status: 200 },
    );
    const events: StorageRequestEvent[] = [];
    const target = create_storage_target({
      targetId: 'replica-eu',
      s3Endpoint: fake.endpoint,
      s3AccessKey: 'test',
      s3SecretKey: 'test',
      encryptionPassphrase: PASSPHRASE,
      onStorageRequest: (event) => events.push(event),
    });

    await target.create_context('00000000-0000-0000-0000-000000000000');

    expect(events.map((event) => [event.command, event.target])).toEqual([
      ['HeadBucket', 'replica-eu'],
      ['HeadObject', 'replica-eu'],
    ]);
  });

  it('refuses an onStorageRequest that is not a function', () => {
    expect(() =>
      create_storage_target({
        s3Endpoint: 'http://127.0.0.1:1',
        s3AccessKey: 'test',
        s3SecretKey: 'test',
        encryptionPassphrase: PASSPHRASE,
        onStorageRequest: 'log' as never,
      }),
    ).toThrow(ConfigError);
  });
});
