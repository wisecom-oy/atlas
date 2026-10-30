import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  ONEDRIVE_CONNECTOR_TOKEN,
  RESTORE_CONNECTOR_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  THROTTLE_COORDINATOR_TOKEN,
} from '@wisecom/atlas-types';
import type { AtlasInstanceConfig, ThrottleCoordinator } from '@wisecom/atlas-types';
import { get_active_throttle } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { createAtlasInstance } from '@/atlas-instance.adapter';
import { create_container_from_config } from '@/container';
import { normalize_config } from '@/instance-config';

const config: AtlasInstanceConfig = {
  tenantId: randomUUID(),
  clientId: randomUUID(),
  clientSecret: '<redacted>',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: '<redacted>',
  s3SecretKey: '<redacted>',
  encryptionPassphrase: '<redacted>'.repeat(2),
};

const host: ThrottleCoordinator = { wait: async () => undefined, raise: () => undefined };

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Calls `method` on a connector resolved from the container, with the real Graph method replaced
 * by one that records the throttle context it ran under.
 */
async function throttle_seen_by(token: symbol, method: string, coordinator?: ThrottleCoordinator) {
  const container = create_container_from_config(normalize_config(config), coordinator);
  const connector = container.get<Record<string, (...args: unknown[]) => Promise<unknown>>>(token);
  let seen: ReturnType<typeof get_active_throttle>;
  vi.spyOn(Object.getPrototypeOf(connector), method).mockImplementation(async () => {
    seen = get_active_throttle();
    return [];
  });
  await connector[method]!('tenant');
  return seen;
}

describe('throttleCoordinator instance option (#551)', () => {
  it('binds the host coordinator in place of the default', () => {
    const container = create_container_from_config(normalize_config(config), host);

    expect(container.get(THROTTLE_COORDINATOR_TOKEN)).toBe(host);
  });

  it('defaults to an in-process coordinator', () => {
    const container = create_container_from_config(normalize_config(config));

    expect(container.get(THROTTLE_COORDINATOR_TOKEN)).toBeInstanceOf(InProcessThrottleCoordinator);
  });

  it('runs OneDrive and SharePoint connector calls under it, on the drive pool', async () => {
    await expect(throttle_seen_by(ONEDRIVE_CONNECTOR_TOKEN, 'list_drives', host)).resolves.toEqual({
      coordinator: host,
      pool: 'sharepoint_onedrive',
    });
    await expect(throttle_seen_by(SHAREPOINT_CONNECTOR_TOKEN, 'list_sites', host)).resolves.toEqual(
      {
        coordinator: host,
        pool: 'sharepoint_onedrive',
      },
    );
  });

  it('runs Outlook restore connector calls under it, on the Outlook pool', async () => {
    await expect(
      throttle_seen_by(RESTORE_CONNECTOR_TOKEN, 'create_mail_folder', host),
    ).resolves.toEqual({ coordinator: host, pool: 'outlook' });
  });

  it('rejects a coordinator without wait and raise', () => {
    const bad = { wait: async () => undefined } as unknown as ThrottleCoordinator;

    expect(() => createAtlasInstance({ ...config, throttleCoordinator: bad })).toThrow(ConfigError);
  });
});
