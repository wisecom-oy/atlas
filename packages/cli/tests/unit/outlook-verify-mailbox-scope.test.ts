import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import {
  CATALOG_USE_CASE_TOKEN,
  NotFoundError,
  USER_IDENTITY_RESOLVER_TOKEN,
  VERIFICATION_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { execute_outlook_verify } from '@/commands/outlook-mgmt.handler';

/**
 * Issue #516. `atlas outlook verify` required `-m` but never read it, so naming another mailbox
 * verified the snapshot anyway under the wrong banner. The snapshot's owner is now checked first.
 */
const JOHN_ID = '9a1f4d2e-6b3c-4a5e-8d7f-2e3a4b5c6d7e';
const JANE_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

describe('atlas outlook verify -m', () => {
  let get_snapshot_detail: ReturnType<typeof vi.fn>;
  let verify_snapshot_integrity: ReturnType<typeof vi.fn>;
  let container: Container;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    get_snapshot_detail = vi.fn().mockResolvedValue({ snapshot_id: 'snap-1', owner_id: JOHN_ID });
    verify_snapshot_integrity = vi.fn().mockResolvedValue({
      snapshot_id: 'snap-1',
      total_checked: 1,
      passed: 1,
      failed: [],
      unverifiable: [],
      interrupted: false,
      manifests_in_chain: 1,
    });
    const directory: Record<string, string> = {
      'john.doe@example.com': JOHN_ID,
      'jane.roe@example.com': JANE_ID,
    };
    container = new Container();
    container.bind(CATALOG_USE_CASE_TOKEN).toConstantValue({ get_snapshot_detail });
    container.bind(VERIFICATION_USE_CASE_TOKEN).toConstantValue({ verify_snapshot_integrity });
    container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'tenant-1' });
    container.bind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({
      resolve_user: vi.fn(async (_t: string, address: string) => ({
        object_id: directory[address.toLowerCase()],
        email: address,
      })),
    });
  });

  afterEach(() => vi.restoreAllMocks());

  const verify = (mailbox: string): Promise<void> =>
    execute_outlook_verify(container, { mailbox, snapshot: 'snap-1' });

  it('refuses a snapshot owned by another mailbox and verifies nothing', async () => {
    await expect(verify('jane.roe@example.com')).rejects.toBeInstanceOf(NotFoundError);
    expect(verify_snapshot_integrity).not.toHaveBeenCalled();
  });

  it('verifies when the address resolves to the owner', async () => {
    await verify('john.doe@example.com');
    expect(verify_snapshot_integrity).toHaveBeenCalledOnce();
  });

  it('verifies when the object ID is given in another case', async () => {
    await verify(JOHN_ID.toUpperCase());
    expect(verify_snapshot_integrity).toHaveBeenCalledOnce();
  });

  it('verifies a v5 snapshot keyed by the address without asking Graph', async () => {
    get_snapshot_detail.mockResolvedValue({
      snapshot_id: 'snap-1',
      owner_id: 'john.doe@example.com',
    });
    // A v5 owner may no longer exist in the directory.
    container.rebind(USER_IDENTITY_RESOLVER_TOKEN).toConstantValue({
      resolve_user: vi.fn().mockRejectedValue(new NotFoundError('user not found')),
    });
    await verify('John.Doe@example.com');
    expect(verify_snapshot_integrity).toHaveBeenCalledOnce();
  });

  it('reports a missing snapshot as not found', async () => {
    get_snapshot_detail.mockResolvedValue(undefined);
    await expect(verify('john.doe@example.com')).rejects.toBeInstanceOf(NotFoundError);
  });
});
