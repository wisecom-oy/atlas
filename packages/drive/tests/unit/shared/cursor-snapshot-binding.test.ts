import { describe, expect, it, vi } from 'vitest';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { latest_readable } from '@wisecom/atlas-types/testing/readable-listing';
import {
  describe_outlived_binding,
  explain_outlived_cursor,
  outlived_cursor_warning,
  resolve_saved_cursor_binding,
  select_resumable_cursor,
} from '@/shared/cursor-snapshot-binding';
import { build_drive_storage_keys } from '@/shared/storage-keys';

/**
 * Issue #725: a drive cursor that outlived the snapshot it was saved with was resumed anyway, so
 * the changes only that snapshot recorded were in no snapshot until the files changed again.
 */
const OWNER = '00000000-0000-0000-0000-00000000abcd';
const KEYS = build_drive_storage_keys('onedrive');
const key_of = (snapshot_id: string): string => KEYS.manifest_key(OWNER, snapshot_id);

describe('describe_outlived_binding', () => {
  it('resumes a cursor whose snapshot still has a manifest', () => {
    expect(describe_outlived_binding('snap-2', [key_of('snap-1'), key_of('snap-2')], key_of)).toBe(
      undefined,
    );
  });

  it('resumes a cursor bound to an older snapshot that still exists', () => {
    // A no-change run keeps the binding, and a crash between the manifest and the cursor write
    // leaves the cursor one snapshot behind. Behind reads changes twice; it skips none.
    expect(describe_outlived_binding('snap-1', [key_of('snap-1'), key_of('snap-2')], key_of)).toBe(
      undefined,
    );
  });

  it('refuses a cursor whose snapshot was deleted or quarantined, and names it', () => {
    expect(describe_outlived_binding('snap-2', [key_of('snap-1')], key_of)).toMatch(
      /snapshot snap-2.*no longer exists/,
    );
    expect(describe_outlived_binding('snap-2', [], key_of)).toMatch(/snap-2/);
  });

  it('keeps trusting a cursor written before the binding while any manifest exists', () => {
    expect(describe_outlived_binding(undefined, [key_of('snap-1')], key_of)).toBe(undefined);
  });

  it('refuses a cursor written before the binding once no manifest exists', () => {
    expect(describe_outlived_binding(undefined, [], key_of)).toMatch(/no snapshot exists/);
  });

  it('resumes a cursor saved without any snapshot while there is still none', () => {
    expect(describe_outlived_binding(null, [], key_of)).toBe(undefined);
  });

  it('refuses a cursor saved without any snapshot once a manifest exists', () => {
    expect(describe_outlived_binding(null, [key_of('snap-1')], key_of)).toMatch(
      /before the first snapshot/,
    );
  });
});

describe('explain_outlived_cursor', () => {
  function bucket_with(...snapshot_ids: string[]) {
    const harness = in_memory_tenant_context();
    for (const id of snapshot_ids) harness.set_raw(key_of(id), Buffer.from('x'));
    // Another owner's manifest must never count for this one.
    harness.set_raw(KEYS.manifest_key('someone-else', 'snap-9'), Buffer.from('x'));
    return harness.ctx;
  }

  it('reads nothing when no cursor is stored', async () => {
    const ctx = bucket_with('snap-1');
    const list = vi.spyOn(ctx.storage, 'list');

    expect(await explain_outlived_cursor(ctx, KEYS, OWNER, undefined)).toBe(undefined);
    expect(list).not.toHaveBeenCalled();
  });

  it('costs one listing of the owner and no manifest read', async () => {
    const ctx = bucket_with('snap-1', 'snap-2');
    const list = vi.spyOn(ctx.storage, 'list');
    const get = vi.spyOn(ctx.storage, 'get');

    expect(await explain_outlived_cursor(ctx, KEYS, OWNER, { snapshot_id: 'snap-2' })).toBe(
      undefined,
    );
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(KEYS.manifest_prefix_for(OWNER));
    expect(get).not.toHaveBeenCalled();
  });

  it('refuses a cursor whose manifest is gone from the bucket', async () => {
    const ctx = bucket_with('snap-1');

    expect(await explain_outlived_cursor(ctx, KEYS, OWNER, { snapshot_id: 'snap-2' })).toMatch(
      /snap-2/,
    );
  });

  it('does not let another owner keep an unbound cursor alive', async () => {
    const ctx = bucket_with();

    expect(await explain_outlived_cursor(ctx, KEYS, OWNER, {})).toMatch(/no snapshot exists/);
  });
});

describe('resolve_saved_cursor_binding', () => {
  const never_looked_up = vi.fn(async () => latest_readable({ snapshot_id: 'unexpected' }));

  it('binds to the snapshot the run wrote', async () => {
    expect(
      await resolve_saved_cursor_binding('snap-3', { snapshot_id: 'snap-2' }, never_looked_up),
    ).toBe('snap-3');
    expect(never_looked_up).not.toHaveBeenCalled();
  });

  it('keeps the binding of a resumed cursor when the run wrote nothing, without a read', async () => {
    expect(
      await resolve_saved_cursor_binding(undefined, { snapshot_id: 'snap-2' }, never_looked_up),
    ).toBe('snap-2');
    expect(
      await resolve_saved_cursor_binding(undefined, { snapshot_id: null }, never_looked_up),
    ).toBe(null);
    expect(never_looked_up).not.toHaveBeenCalled();
  });

  it('binds an unbound cursor to the newest readable snapshot on its first quiet run', async () => {
    const find = vi.fn(async () => latest_readable({ snapshot_id: 'snap-1' }));

    expect(await resolve_saved_cursor_binding(undefined, {}, find)).toBe('snap-1');
  });

  it('looks the newest snapshot up after a run that resumed nothing and wrote nothing', async () => {
    const find = vi.fn(async () => latest_readable({ snapshot_id: 'snap-1' }));

    expect(await resolve_saved_cursor_binding(undefined, undefined, find)).toBe('snap-1');
  });

  it('records that no snapshot exists', async () => {
    const find = vi.fn(async () => latest_readable<{ snapshot_id: string }>());

    expect(await resolve_saved_cursor_binding(undefined, undefined, find)).toBe(null);
  });
});

describe('outlived_cursor_warning', () => {
  it('says why the links are not resumed and what the run does instead', () => {
    const warning = outlived_cursor_warning('snapshot snap-2 no longer exists', 'library');

    expect(warning).toContain('snapshot snap-2 no longer exists');
    expect(warning).toContain('every library in full');
  });
});

describe('select_resumable_cursor', () => {
  const cursor = { snapshot_id: 'snap-2', delta_link_by_drive: { d1: 'link' } };

  function bucket_with(...snapshot_ids: string[]) {
    const harness = in_memory_tenant_context();
    for (const id of snapshot_ids) harness.set_raw(key_of(id), Buffer.from('x'));
    return harness.ctx;
  }
  const select = (
    ctx: ReturnType<typeof bucket_with>,
    request: { force_full?: boolean; scope_changed?: boolean } = {},
  ) =>
    select_resumable_cursor(ctx, KEYS, OWNER, cursor, {
      unit: 'drive',
      force_full: request.force_full === true,
      ...(request.scope_changed !== undefined ? { scope_changed: request.scope_changed } : {}),
    });

  it('resumes everything from a cursor whose snapshot exists', async () => {
    expect(await select(bucket_with('snap-2'))).toEqual({
      previous_cursor: cursor,
      watermark_cursor: cursor,
      outlived_warning: undefined,
    });
  });

  it('resumes nothing from a cursor that outlived its snapshot, and says why', async () => {
    const resume = await select(bucket_with('snap-1'));

    expect(resume.previous_cursor).toBeUndefined();
    expect(resume.watermark_cursor).toBeUndefined();
    expect(resume.outlived_warning).toMatch(/snap-2.*every drive in full/);
  });

  it('keeps the version watermarks for --full and for a changed scope', async () => {
    const ctx = bucket_with('snap-2');

    for (const request of [{ force_full: true }, { scope_changed: true }]) {
      const resume = await select(ctx, request);
      expect(resume.previous_cursor).toBeUndefined();
      expect(resume.watermark_cursor).toBe(cursor);
      expect(resume.outlived_warning).toBeUndefined();
    }
  });

  it('drops the watermarks of an outlived cursor under --full too, without the warning', async () => {
    const resume = await select(bucket_with('snap-1'), { force_full: true });

    expect(resume.watermark_cursor).toBeUndefined();
    expect(resume.outlived_warning).toBeUndefined();
  });
});
