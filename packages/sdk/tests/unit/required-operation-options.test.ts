import { describe, expect, it, vi } from 'vitest';
import { adapt_operation_options, adapt_required_operation_options } from '@/operation-options';
import type { Container } from 'inversify';
import {
  ONEDRIVE_RESTORE_USE_CASE_TOKEN,
  ONEDRIVE_SAVE_USE_CASE_TOKEN,
  ONEDRIVE_VERIFICATION_USE_CASE_TOKEN,
  SHAREPOINT_RESTORE_USE_CASE_TOKEN,
  SHAREPOINT_SAVE_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { create_onedrive_api } from '@/onedrive-api.factory';
import { create_sharepoint_api } from '@/sharepoint-api.factory';

/**
 * Issue #204: four SDK entry points forwarded a mandatory options object through a non-null
 * assertion. TypeScript callers cannot reach that, but the package ships to JavaScript, and there
 * omitting the argument crashed several frames deep with
 * `Cannot read properties of undefined (reading 'should_interrupt')`, naming an internal control
 * flag instead of the mistake.
 */
describe('adapt_required_operation_options', () => {
  it('returns the adapted options when snapshotId is present', () => {
    const adapted = adapt_required_operation_options(
      { snapshotId: 'snap-example-1' },
      'onedrive.restore()',
    );

    // Public in, internal out: the service ports declare `snapshot_id` (issue #45).
    expect(adapted).toEqual({ snapshot_id: 'snap-example-1' });
  });

  it('names the method and the missing field when options are omitted', () => {
    expect(() => adapt_required_operation_options(undefined, 'onedrive.restore()')).toThrow(
      /onedrive\.restore\(\) requires an options object with a snapshotId/,
    );
  });

  it('fails the same way when snapshotId is missing from the object', () => {
    expect(() =>
      adapt_required_operation_options({ fileFilter: ['/a.docx'] } as never, 'onedrive.save()'),
    ).toThrow(/requires an options object with a snapshotId/);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
  ])('rejects an %s snapshotId (%s)', (snapshot_id) => {
    expect(() =>
      adapt_required_operation_options({ snapshotId: snapshot_id }, 'sharepoint.restore()'),
    ).toThrow(/requires an options object with a snapshotId/);
  });

  it('rejects a non-string snapshotId instead of passing it through', () => {
    expect(() =>
      adapt_required_operation_options({ snapshotId: 42 } as never, 'sharepoint.save()'),
    ).toThrow(/requires an options object with a snapshotId/);
  });

  it('throws a TypeError, since this is an argument problem', () => {
    expect(() => adapt_required_operation_options(undefined, 'onedrive.save()')).toThrow(TypeError);
  });

  it('still maps signal and onProgress like the optional adapter', () => {
    const controller = new AbortController();
    const on_progress = vi.fn();
    const adapted = adapt_required_operation_options(
      { snapshotId: 'snap-example-1', signal: controller.signal, onProgress: on_progress },
      'onedrive.restore()',
    ) as { should_interrupt?: () => boolean; on_progress?: (event: unknown) => void };

    expect(adapted.should_interrupt?.()).toBe(false);
    controller.abort();
    expect(adapted.should_interrupt?.()).toBe(true);

    adapted.on_progress?.({ phase: 'processing' });
    expect(on_progress).toHaveBeenCalledTimes(1);
  });
});

describe('adapt_operation_options', () => {
  it('still returns undefined for absent options, which verify() relies on', () => {
    // verify() takes options optionally and calls the use case with a shorter argument list when
    // they are absent, so the optional adapter must keep returning undefined.
    expect(adapt_operation_options(undefined)).toBeUndefined();
  });
});

describe('SDK entry points with options omitted', () => {
  const TENANT = 'tenant-1';
  const SITE_ID =
    'contoso.sharepoint.com,00000000-0000-0000-0000-000000000000,11111111-1111-1111-1111-111111111111';

  function container_with(...entries: [symbol, unknown][]): Container {
    const services = new Map(entries);
    return {
      get: vi.fn((requested: symbol) => services.get(requested) ?? {}),
    } as unknown as Container;
  }

  it('onedrive.restore() rejects instead of crashing in the service', async () => {
    const restore_onedrive = vi.fn();
    const api = create_onedrive_api(
      TENANT,
      container_with([ONEDRIVE_RESTORE_USE_CASE_TOKEN, { restore_onedrive }]),
    );

    await expect(
      (api.restore as (owner: string) => Promise<unknown>)('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/onedrive\.restore\(\) requires an options object with a snapshotId/);
    expect(restore_onedrive).not.toHaveBeenCalled();
  });

  it('onedrive.save() rejects instead of crashing in the service', async () => {
    const save_snapshot = vi.fn();
    const api = create_onedrive_api(
      TENANT,
      container_with([ONEDRIVE_SAVE_USE_CASE_TOKEN, { save_snapshot }]),
    );

    await expect(
      (api.save as (owner: string) => Promise<unknown>)('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/onedrive\.save\(\) requires an options object with a snapshotId/);
    expect(save_snapshot).not.toHaveBeenCalled();
  });

  it('sharepoint.restore() rejects instead of crashing in the service', async () => {
    const restore_sharepoint = vi.fn();
    const api = create_sharepoint_api(
      TENANT,
      container_with([SHAREPOINT_RESTORE_USE_CASE_TOKEN, { restore_sharepoint }]),
    );

    await expect((api.restore as (site: string) => Promise<unknown>)(SITE_ID)).rejects.toThrow(
      /sharepoint\.restore\(\) requires an options object with a snapshotId/,
    );
    expect(restore_sharepoint).not.toHaveBeenCalled();
  });

  it('sharepoint.save() rejects instead of crashing in the service', async () => {
    const save_snapshot = vi.fn();
    const api = create_sharepoint_api(
      TENANT,
      container_with([SHAREPOINT_SAVE_USE_CASE_TOKEN, { save_snapshot }]),
    );

    await expect((api.save as (site: string) => Promise<unknown>)(SITE_ID)).rejects.toThrow(
      /sharepoint\.save\(\) requires an options object with a snapshotId/,
    );
    expect(save_snapshot).not.toHaveBeenCalled();
  });

  it('onedrive().verify() still works with options omitted', async () => {
    const verify_onedrive_snapshot = vi.fn().mockResolvedValue({ healthy: true });
    const api = create_onedrive_api(
      TENANT,
      container_with([ONEDRIVE_VERIFICATION_USE_CASE_TOKEN, { verify_onedrive_snapshot }]),
    );

    await expect(
      api.verify('00000000-0000-0000-0000-000000000000', 'snap-example-1'),
    ).resolves.toEqual({ healthy: true });
    // Called without a fourth argument, which is the shape verify() has always used.
    expect(verify_onedrive_snapshot).toHaveBeenCalledWith(
      TENANT,
      '00000000-0000-0000-0000-000000000000',
      'snap-example-1',
    );
  });
});
