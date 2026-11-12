import { describe, expect, it } from 'vitest';
import {
  UnreadableContentError,
  UnsupportedFormatVersionError,
  type TenantContext,
} from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  load_encrypted_json,
  load_encrypted_json_bound_to_key,
  load_encrypted_json_with_etag,
} from '@/services/shared/encrypted-state-reader';

interface OwnedState {
  readonly owner_id: string;
}

const key_of = (state: OwnedState): string => `_meta/state/${state.owner_id.toLowerCase()}.json`;
const KEY = '_meta/state/owner-b.json';

function plant(harness: ReturnType<typeof in_memory_tenant_context>, body: string): void {
  harness.set_raw(KEY, harness.ctx.encrypt(Buffer.from(body, 'utf-8'), KEY));
}

describe('load_encrypted_json_bound_to_key', () => {
  it('returns a body whose owner rebuilds the key it was read from', async () => {
    const harness = in_memory_tenant_context();
    plant(harness, JSON.stringify({ owner_id: 'Owner-B' }));

    await expect(load_encrypted_json_bound_to_key(harness.ctx, KEY, key_of)).resolves.toEqual({
      owner_id: 'Owner-B',
    });
  });

  it('returns undefined when the object is absent', async () => {
    const { ctx } = in_memory_tenant_context();

    await expect(load_encrypted_json_bound_to_key(ctx, KEY, key_of)).resolves.toBeUndefined();
  });

  it('rejects a body that names another owner', async () => {
    const harness = in_memory_tenant_context();
    plant(harness, JSON.stringify({ owner_id: 'owner-a' }));

    const err = await load_encrypted_json_bound_to_key(harness.ctx, KEY, key_of).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UnreadableContentError);
    expect((err as Error).message).toContain(KEY);
  });

  it('rejects a body the key builder cannot read', async () => {
    const harness = in_memory_tenant_context();
    plant(harness, '{}');

    await expect(load_encrypted_json_bound_to_key(harness.ctx, KEY, key_of)).rejects.toBeInstanceOf(
      UnreadableContentError,
    );
  });
});

/** A context holding one state object whose envelope a newer Atlas wrote. */
function ctx_with_newer_format_state(): TenantContext {
  const harness = in_memory_tenant_context();
  plant(harness, JSON.stringify({ owner_id: 'owner-b' }));
  return {
    ...harness.ctx,
    decrypt: () => {
      throw new UnsupportedFormatVersionError('Unsupported content envelope version 2');
    },
  };
}

describe('state written by a newer Atlas format', () => {
  it('raises UnsupportedFormatVersionError from load_encrypted_json, not damage', async () => {
    const load = load_encrypted_json(ctx_with_newer_format_state(), KEY);

    await expect(load).rejects.toBeInstanceOf(UnsupportedFormatVersionError);
    await expect(load).rejects.not.toBeInstanceOf(UnreadableContentError);
  });

  it('raises UnsupportedFormatVersionError from load_encrypted_json_bound_to_key', async () => {
    await expect(
      load_encrypted_json_bound_to_key(ctx_with_newer_format_state(), KEY, key_of),
    ).rejects.toBeInstanceOf(UnsupportedFormatVersionError);
  });

  it('raises UnsupportedFormatVersionError from load_encrypted_json_with_etag', async () => {
    await expect(
      load_encrypted_json_with_etag(ctx_with_newer_format_state(), KEY),
    ).rejects.toBeInstanceOf(UnsupportedFormatVersionError);
  });

  it('still raises UnreadableContentError for a body that does not decrypt', async () => {
    const harness = in_memory_tenant_context();
    harness.set_raw(KEY, Buffer.from('damaged in storage, long enough to hold a tag'));

    await expect(load_encrypted_json(harness.ctx, KEY)).rejects.toBeInstanceOf(
      UnreadableContentError,
    );
  });
});
