import { describe, it, expect } from 'vitest';
import { cursor_describes_head } from '@/services/shared/delta-cursor-binding';

describe('cursor_describes_head', () => {
  it('trusts a cursor bound to the current head', () => {
    expect(cursor_describes_head('snap-2', 'snap-2')).toBe(true);
  });

  it('distrusts a cursor bound to a snapshot that is no longer the head (#704)', () => {
    expect(cursor_describes_head('snap-2', 'snap-1')).toBe(false);
  });

  it('distrusts any cursor when no readable manifest exists (#703)', () => {
    expect(cursor_describes_head('snap-2', undefined)).toBe(false);
    expect(cursor_describes_head(undefined, undefined)).toBe(false);
  });

  it('keeps trusting a cursor written before the binding while a head exists', () => {
    expect(cursor_describes_head(undefined, 'snap-1')).toBe(true);
  });
});
