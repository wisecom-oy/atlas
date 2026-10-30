import { describe, expect, it, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectLockConfigurationCommand } from '@aws-sdk/client-s3';
import { read_bucket_default_retention } from '@/adapters/s3-default-retention';

function client_answering(response: unknown): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue(response) };
}

describe('read_bucket_default_retention', () => {
  it('returns undefined when the configuration has no rule', async () => {
    const client = client_answering({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } });

    await expect(
      read_bucket_default_retention(client as unknown as S3Client, 'atlas-example-bucket'),
    ).resolves.toBeUndefined();
    expect(client.send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectLockConfigurationCommand);
  });

  it('reads a default retention in days', async () => {
    const client = client_answering({
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 30 } },
      },
    });

    await expect(
      read_bucket_default_retention(client as unknown as S3Client, 'atlas-example-bucket'),
    ).resolves.toEqual({ mode: 'COMPLIANCE', days: 30 });
  });

  it('reads a default retention in years', async () => {
    const client = client_answering({
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Years: 1 } },
      },
    });

    await expect(
      read_bucket_default_retention(client as unknown as S3Client, 'atlas-example-bucket'),
    ).resolves.toEqual({ mode: 'GOVERNANCE', years: 1 });
  });
});
