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

  it('returns undefined when a contact has neither a name nor an email', () => {
    expect(collision_key({ displayName: '  ' })).toBeUndefined();
  });
});
