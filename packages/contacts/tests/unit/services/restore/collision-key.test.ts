import { describe, expect, it } from 'vitest';

import { collision_key } from '@/services/restore/collision-key';

describe('collision_key', () => {
  it('matches the same person regardless of case, spacing, or email order', () => {
    const a = collision_key({
      displayName: '  Ada Example ',
      emailAddresses: [{ address: 'B@example.com' }, { address: 'a@example.com' }],
    });
    const b = collision_key({
      displayName: 'ada example',
      emailAddresses: [{ address: 'a@example.com' }, { address: 'b@example.com' }],
    });
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('separates contacts that share a name but have different emails', () => {
    const a = collision_key({
      displayName: 'Sam',
      emailAddresses: [{ address: 'sam@example.com' }],
    });
    const b = collision_key({
      displayName: 'Sam',
      emailAddresses: [{ address: 'sam@contoso.com' }],
    });
    expect(a).not.toBe(b);
  });

  it('separates contacts that share a name and have no email but different phones', () => {
    const a = collision_key({ displayName: 'Sam', businessPhones: ['+1 555 0101'] });
    const b = collision_key({ displayName: 'Sam', mobilePhone: '+1 555 0102' });
    expect(a).not.toBe(b);
  });

  it('separates contacts that share a name but work for different companies', () => {
    expect(collision_key({ displayName: 'Sam', companyName: 'Example Ltd' })).not.toBe(
      collision_key({ displayName: 'Sam', companyName: 'Contoso' }),
    );
  });

  it('ignores whitespace in phone numbers', () => {
    expect(collision_key({ homePhones: ['+1 555 0101'] })).toBe(
      collision_key({ homePhones: ['+15550101'] }),
    );
  });

  it('returns undefined when a contact has no name, email, phone or company', () => {
    expect(collision_key({ displayName: '  ', businessPhones: [''] })).toBeUndefined();
  });
});
