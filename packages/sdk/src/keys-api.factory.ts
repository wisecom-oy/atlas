import type { Container } from 'inversify';
import type { KeysApi, TenantSetRewrapUseCase } from '@wisecom/atlas-types';
import { TENANT_SET_REWRAP_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { camelize } from '@wisecom/atlas-types/public/case-convert';

/**
 * Builds the KeysApi sub-namespace. Every option defaults to this instance: its tenant and its
 * configured passphrase.
 */
export function create_keys_api(
  tenant_id: string,
  configured_passphrase: string,
  container: Container,
): KeysApi {
  const rewrap = container.get<TenantSetRewrapUseCase>(TENANT_SET_REWRAP_USE_CASE_TOKEN);
  return {
    async rewrapTenantKeys(options = {}) {
      return camelize(
        await rewrap.rewrap_tenant_set({
          tenant_ids: options.tenantIds ?? [tenant_id],
          current_passphrase: options.currentPassphrase ?? configured_passphrase,
          next_passphrase: options.newPassphrase ?? configured_passphrase,
        }),
      );
    },
  };
}
