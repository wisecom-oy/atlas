import { describe, expect, it } from 'vitest';
import { save_exit_code } from '@/commands/teams/save-exit-code';

const CLEAN = { errors: [], hosted_missing: [], interrupted: false };

describe('save_exit_code', () => {
  it('returns no code for a complete archive', () => {
    expect(save_exit_code(CLEAN)).toBeUndefined();
  });

  it('exits 1 when an item could not be read, even with uncaptured hosted content', () => {
    expect(
      save_exit_code({ ...CLEAN, errors: ['message r1: blob missing'], hosted_missing: ['x'] }),
    ).toBe(1);
  });

  it('exits 2 when hosted content was never captured, so the archive is partial', () => {
    expect(
      save_exit_code({
        ...CLEAN,
        hosted_missing: ['message r1: hosted content h2 was not captured'],
      }),
    ).toBe(2);
  });

  it('exits 2 for an interrupted export', () => {
    expect(save_exit_code({ ...CLEAN, interrupted: true })).toBe(2);
  });
});
