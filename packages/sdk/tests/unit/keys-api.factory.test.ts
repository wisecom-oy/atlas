import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Container } from 'inversify';
import {
  OLD_WRAPPER_PURGE_USE_CASE_TOKEN,
  TENANT_SET_REWRAP_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { create_keys_api } from '@/keys-api.factory';

/** Issue #716: the SDK reaches the same tenant-set re-wrap and purge as `atlas keys`. */

const TENANT_ID = 'tenant-1';
const CONFIGURED = 'FAKE-configured-passphrase';

const rewrap = { rewrap_tenant_set: vi.fn() };
const purge = { purge_old_wrappers: vi.fn() };
const by_token = new Map<symbol, unknown>([
  [TENANT_SET_REWRAP_USE_CASE_TOKEN, rewrap],
  [OLD_WRAPPER_PURGE_USE_CASE_TOKEN, purge],
]);
const container = { get: (token: symbol) => by_token.get(token) } as unknown as Container;

describe('create_keys_api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rewrap.rewrap_tenant_set.mockResolvedValue({
      outcomes: [{ tenant_id: TENANT_ID, status: 'already_rewrapped' }],
      passphrase_changed: true,
      complete: true,
    });
    purge.purge_old_wrappers.mockResolvedValue({ outcomes: [], complete: true });
  });

  it('defaults to this tenant and a KDF-only refresh under the configured passphrase', async () => {
    await create_keys_api(TENANT_ID, CONFIGURED, container).rewrapTenantKeys();

    expect(rewrap.rewrap_tenant_set).toHaveBeenCalledWith({
      tenant_ids: [TENANT_ID],
      current_passphrase: CONFIGURED,
      next_passphrase: CONFIGURED,
    });
  });

  it('passes tenants and passphrases through and camelizes the report', async () => {
    const report = await create_keys_api(TENANT_ID, CONFIGURED, container).rewrapTenantKeys({
      tenantIds: ['a', 'b'],
      newPassphrase: 'FAKE-new-passphrase-value',
    });

    expect(rewrap.rewrap_tenant_set).toHaveBeenCalledWith({
      tenant_ids: ['a', 'b'],
      current_passphrase: CONFIGURED,
      next_passphrase: 'FAKE-new-passphrase-value',
    });
    expect(report).toEqual({
      outcomes: [{ tenantId: TENANT_ID, status: 'already_rewrapped' }],
      passphraseChanged: true,
      complete: true,
    });
  });

  it('purges this tenant with no previous passphrase by default', async () => {
    await create_keys_api(TENANT_ID, CONFIGURED, container).purgeOldWrappers();

    expect(purge.purge_old_wrappers).toHaveBeenCalledWith({
      tenant_ids: [TENANT_ID],
      previous_passphrases: [],
    });
  });
});
