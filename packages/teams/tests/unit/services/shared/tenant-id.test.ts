import { describe, expect, it } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import { assert_tenant_guid } from '@/services/shared/tenant-id';

const TENANT = '00000000-0000-0000-0000-000000000001';

describe('assert_tenant_guid', () => {
  it('accepts a GUID in either letter case', () => {
    expect(() => assert_tenant_guid(TENANT)).not.toThrow();
    expect(() => assert_tenant_guid(TENANT.toUpperCase())).not.toThrow();
  });

  it.each(['', 'contoso.onmicrosoft.com', 'tenant-1', `${TENANT}/x`])(
    'rejects %j, which is not a GUID (#723)',
    (value) => {
      expect(() => assert_tenant_guid(value)).toThrow(ConfigError);
    },
  );

  it('names the GUID requirement in the error message', () => {
    expect(() => assert_tenant_guid('contoso.onmicrosoft.com')).toThrow('tenant GUID');
  });
});
