/**
 * Issue #974: `ATLAS_SINGLE_WRITER` replaces the storage lease with the in-process exclusion and
 * says so on stderr; without it the CLI keeps the storage lease and stays silent.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { logger } from '@wisecom/atlas-core';
import { ExclusionOwnerLeases } from '@wisecom/atlas-core/services/lease/exclusion-owner-leases';
import { StorageOwnerLeases } from '@wisecom/atlas-core/services/lease/storage-owner-leases';
import { OWNER_LEASE_TOKEN, type OwnerLeasePort } from '@wisecom/atlas-types';
import { compose_container_from_config } from '@/container';

const CONFIG = {
  tenant_id: 'tenant-example',
  client_id: 'client-example',
  client_secret: '<redacted>',
  s3_endpoint: 'https://storage.example.com',
  s3_access_key: '<redacted>',
  s3_secret_key: '<redacted>',
  s3_region: 'us-east-1',
  encryption_passphrase: '<redacted>',
} satisfies AtlasConfig;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CLI container writer exclusion (issue #974)', () => {
  it('keeps the storage lease by default, without a notice', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const leases = compose_container_from_config(CONFIG).get<OwnerLeasePort>(OWNER_LEASE_TOKEN);

    expect(leases).toBeInstanceOf(StorageOwnerLeases);
    expect(warn).not.toHaveBeenCalled();
  });

  it('binds the in-process exclusion in single-writer mode and warns that it is on', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const leases = compose_container_from_config({
      ...CONFIG,
      writer_exclusion: 'single_writer',
    }).get<OwnerLeasePort>(OWNER_LEASE_TOKEN);

    expect(leases).toBeInstanceOf(ExclusionOwnerLeases);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ATLAS_SINGLE_WRITER is set'));
  });
});
