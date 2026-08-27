import { describe, expect, it } from 'vitest';
import {
  assert_renameable,
  resolve_restore_root,
  restore_parent_path,
} from '@/services/shared/restore-destination';

describe('resolve_restore_root', () => {
  it('generates a timestamped root when nothing is chosen', () => {
    expect(resolve_restore_root({})).toMatch(/^\/Restore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });

  it('restores in place only when asked explicitly', () => {
    expect(resolve_restore_root({ in_place: true })).toBe('');
  });

  it('takes an explicit destination and normalises its slashes', () => {
    expect(resolve_restore_root({ destination: 'Restored' })).toBe('/Restored');
    expect(resolve_restore_root({ destination: '/DR/2026/' })).toBe('/DR/2026');
  });

  it('treats a destination of the drive root as in place, since that is the original layout', () => {
    expect(resolve_restore_root({ destination: '/' })).toBe('');
  });

  it('lets in-place win over a destination rather than silently picking one', () => {
    expect(resolve_restore_root({ destination: '/DR', in_place: true })).toBe('');
  });

  it('ignores a blank destination instead of restoring to the drive root', () => {
    expect(resolve_restore_root({ destination: '   ' })).toMatch(/^\/Restore-/);
  });
});

describe('restore_parent_path', () => {
  it('recreates the original nesting beneath the root', () => {
    expect(restore_parent_path('/Restore-x', '/Projects/2026')).toBe('/Restore-x/Projects/2026');
  });

  it('puts a root-level file directly in the root', () => {
    expect(restore_parent_path('/Restore-x', '/')).toBe('/Restore-x');
    expect(restore_parent_path('/Restore-x', '.')).toBe('/Restore-x');
    expect(restore_parent_path('/Restore-x', '')).toBe('/Restore-x');
  });

  it('leaves the path untouched when there is no root', () => {
    expect(restore_parent_path('', '/Projects/2026')).toBe('/Projects/2026');
    expect(restore_parent_path('', '/')).toBe('/');
  });

  it('never doubles a separator', () => {
    expect(restore_parent_path('/Restore-x', '//Projects')).toBe('/Restore-x/Projects');
  });
});

describe('assert_renameable', () => {
  it('allows a rename of exactly one file', () => {
    expect(() => assert_renameable('report.docx', 1)).not.toThrow();
  });

  it('refuses a rename spanning several files, naming the count', () => {
    expect(() => assert_renameable('report.docx', 12)).toThrow(/12 files/);
  });

  it('refuses a rename that matched nothing rather than silently doing nothing', () => {
    expect(() => assert_renameable('report.docx', 0)).toThrow(/single file/);
  });

  it('is inert when no rename was asked for', () => {
    expect(() => assert_renameable(undefined, 12)).not.toThrow();
  });
});
