import { GUID_RE } from '@wisecom/atlas-core/utils/config-keys';
import { ConfigError } from '@wisecom/atlas-types';

/**
 * Requires the tenant as a GUID. Channel ownership compares each channel's `tenantId`, which Graph
 * returns as a GUID, so a domain would match none of them and skip every channel (issue #723).
 *
 * @throws ConfigError when the value is not a GUID, such as a `*.onmicrosoft.com` domain.
 */
export function assert_tenant_guid(tenant_id: string): void {
  if (GUID_RE.test(tenant_id)) return;
  throw new ConfigError(
    'Teams backup needs the tenant GUID, not a domain. Channel ownership is compared by GUID, ' +
      'so pass the tenant ID GUID from the Entra admin center.',
  );
}
