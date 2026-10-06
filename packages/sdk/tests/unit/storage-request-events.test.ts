import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import type { AtlasInstance, AtlasInstanceConfig, StorageRequestEvent } from '@wisecom/atlas-types';
import { createAtlasInstance } from '@/atlas-instance.adapter';

const NO_SUCH_KEY =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>';

let server: Server | undefined;
let instance: AtlasInstance | undefined;

afterEach(async () => {
  await instance?.dispose();
  instance = undefined;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A bucket that exists and holds no objects: every object read or HEAD is a 404. */
async function empty_bucket_endpoint(): Promise<string> {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const is_object = /^\/[^/]+\/[^?]+/.test(req.url ?? '');
      const body = is_object && req.method === 'GET' ? NO_SUCH_KEY : '';
      res.writeHead(is_object ? 404 : 200, {
        'content-length': String(body.length),
        'content-type': 'application/xml',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function config_for(endpoint: string, extra: Partial<AtlasInstanceConfig>): AtlasInstanceConfig {
  return {
    tenantId: '00000000-0000-0000-0000-000000000000',
    clientId: '00000000-0000-0000-0000-000000000001',
    clientSecret: '<redacted>',
    s3Endpoint: endpoint,
    s3AccessKey: '<redacted>',
    s3SecretKey: '<redacted>',
    encryptionPassphrase: '<redacted>'.repeat(2),
    ...extra,
  };
}

describe('onStorageRequest', () => {
  it('reports each S3 request an SDK method sends, named after the method', async () => {
    const events: StorageRequestEvent[] = [];
    const atlas = createAtlasInstance(
      config_for(await empty_bucket_endpoint(), {
        onStorageRequest: (event) => events.push(event),
      }),
    );
    instance = atlas;

    // A bucket without a data key holds no backups, so the call fails after reading for one.
    await expect(atlas.getBucketStats()).rejects.toThrow();

    expect(events).toContainEqual(
      expect.objectContaining({
        command: 'GetObject',
        operation: 'getBucketStats',
        target: 'primary',
        keyClass: '_meta',
        errorType: 'NoSuchKey',
        statusCode: 404,
      }),
    );
    expect(events.every((event) => event.operation === 'getBucketStats')).toBe(true);
  });

  it('rejects an onStorageRequest that is not a function', () => {
    expect(() =>
      createAtlasInstance(config_for('http://localhost:9000', { onStorageRequest: {} as never })),
    ).toThrow(ConfigError);
  });
});
