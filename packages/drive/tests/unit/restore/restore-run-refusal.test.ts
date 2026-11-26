/**
 * Issue #871: which failures of a OneDrive or SharePoint restore write end the restore instead of
 * failing one file. Only a refusal that every later write would meet counts, following the 403 rule
 * of #957: an `AuthError`, or a raw Graph 403 whose code names a missing grant.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  MailboxNotLicensedError,
  MissingGraphPermissionsError,
} from '@wisecom/atlas-types';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import {
  is_restore_run_refusal,
  rethrow_if_restore_run_refusal,
} from '@/restore/restore-run-refusal';
import { ensure_drive_folder_path, type DriveFolderCreator } from '@/restore/folder-path';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('is_restore_run_refusal', () => {
  it.each([
    ['an AuthError', new AuthError('refused credentials')],
    ['a MailboxNotLicensedError', new MailboxNotLicensedError('MailboxNotEnabledForRESTAPI')],
    ['a 403 accessDenied', graph_error(403, 'accessDenied')],
    ['a 403 accessDenied in any case', graph_error(403, 'AccessDenied')],
    [
      'a wrapped 403 accessDenied',
      new Error('upload failed', { cause: graph_error(403, 'accessDenied') }),
    ],
  ])('counts %s', (_label, err) => {
    expect(is_restore_run_refusal(err)).toBe(true);
  });

  it.each([
    ['a 403 with another code', graph_error(403, 'notAllowed')],
    ['a 403 with no code', graph_error(403, '')],
    ['a 400', graph_error(400, 'invalidRequest')],
    ['a 409', graph_error(409, 'nameAlreadyExists')],
    ['a plain error', new Error('damaged content object')],
  ])('does not count %s', (_label, err) => {
    expect(is_restore_run_refusal(err)).toBe(false);
  });
});

describe('rethrow_if_restore_run_refusal', () => {
  it('rethrows an AuthError unchanged', () => {
    const refusal = new AuthError('refused credentials');

    expect(() => rethrow_if_restore_run_refusal('onedrive', refusal)).toThrow(refusal);
  });

  it('names the OneDrive write permission for a missing grant', () => {
    const thrown = capture(() =>
      rethrow_if_restore_run_refusal('onedrive', graph_error(403, 'accessDenied')),
    );

    expect(thrown).toBeInstanceOf(MissingGraphPermissionsError);
    expect(thrown).toMatchObject({ permissions: ['Files.ReadWrite.All'], status_code: 403 });
  });

  it('names the SharePoint write permission and the per-site grant for a missing grant', () => {
    const thrown = capture(() =>
      rethrow_if_restore_run_refusal('sharepoint', graph_error(403, 'accessDenied')),
    );

    expect(thrown).toMatchObject({ permissions: ['Sites.ReadWrite.All'] });
    expect((thrown as Error).message).toContain('Sites.Selected');
  });

  it('returns for a failure of one file', () => {
    expect(() =>
      rethrow_if_restore_run_refusal('sharepoint', graph_error(403, 'notAllowed')),
    ).not.toThrow();
  });
});

describe('ensure_drive_folder_path with a refused create', () => {
  function connector_failing_with(err: unknown): DriveFolderCreator {
    return { create_folder: vi.fn().mockRejectedValue(err) };
  }

  it('rethrows a missing grant instead of skipping the path', async () => {
    const refusal = graph_error(403, 'accessDenied');

    await expect(
      ensure_drive_folder_path(connector_failing_with(refusal), 't', 'o', 'd', '/A', new Map()),
    ).rejects.toBe(refusal);
  });

  it('still answers undefined for a folder that fails on its own', async () => {
    const failure = graph_error(400, 'invalidRequest');

    await expect(
      ensure_drive_folder_path(connector_failing_with(failure), 't', 'o', 'd', '/A', new Map()),
    ).resolves.toBeUndefined();
  });
});

/** The value `fn` throws. */
function capture(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}
