import { describe, expect, it } from 'vitest';
import { trim_slashes, trim_trailing_slashes } from '@/services/shared/trim-slashes';

describe('trim_slashes', () => {
  it('removes leading and trailing slashes and keeps the interior', () => {
    expect(trim_slashes('///a/b///')).toBe('a/b');
    expect(trim_slashes('/Projects/2026')).toBe('Projects/2026');
  });

  it('trims an all-slash path to empty', () => {
    expect(trim_slashes('///')).toBe('');
    expect(trim_slashes('')).toBe('');
  });

  it('preserves interior double slashes', () => {
    expect(trim_slashes('/a//b/')).toBe('a//b');
  });
});

describe('trim_trailing_slashes', () => {
  it('removes only trailing slashes', () => {
    expect(trim_trailing_slashes('/a/b//')).toBe('/a/b');
    expect(trim_trailing_slashes('/')).toBe('');
    expect(trim_trailing_slashes('no-slashes')).toBe('no-slashes');
  });
});
