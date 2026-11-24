import { describe, expect, it } from 'vitest';
import { is_valid_bucket_name, tenant_bucket_name } from '@/utils/bucket-name';

describe('tenant_bucket_name', () => {
  it('prefixes the tenant ID with atlas-', () => {
    expect(tenant_bucket_name('11111111-2222-3333-4444-555555555555')).toBe(
      'atlas-11111111-2222-3333-4444-555555555555',
    );
  });

  it('keeps the tenant ID as given, so a bucket an older Atlas derived stays reachable', () => {
    expect(tenant_bucket_name('Contoso.onmicrosoft.com')).toBe('atlas-Contoso.onmicrosoft.com');
  });

  it('derives without validating, even a name S3 would refuse', () => {
    const name = tenant_bucket_name('Contoso.onmicrosoft.com');
    expect(is_valid_bucket_name(name)).toBe(false);
  });
});

describe('is_valid_bucket_name', () => {
  it.each([
    ['abc', 'the 3-character minimum'],
    ['a'.repeat(63), 'the 63-character maximum'],
    ['atlas-contoso.onmicrosoft.com', 'dots and dashes inside'],
    ['0atlas9', 'digits at both ends'],
  ])('accepts %s (%s)', (bucket) => {
    expect(is_valid_bucket_name(bucket)).toBe(true);
  });

  it.each([
    ['ab', 'under 3 characters'],
    ['a'.repeat(64), 'over 63 characters'],
    ['', 'empty'],
    ['Atlas-contoso', 'an uppercase letter'],
    ['-atlas', 'a leading dash'],
    ['atlas-', 'a trailing dash'],
    ['.atlas', 'a leading dot'],
    ['atlas.', 'a trailing dot'],
    ['atlas..contoso', 'adjacent dots'],
    ['atlas_contoso', 'an underscore'],
    ['atlas contoso', 'a space'],
  ])('rejects %j (%s)', (bucket) => {
    expect(is_valid_bucket_name(bucket)).toBe(false);
  });
});
