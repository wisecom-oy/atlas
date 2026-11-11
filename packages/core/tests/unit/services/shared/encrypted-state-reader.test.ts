import { describe, expect, it } from 'vitest';
import { UnreadableContentError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { load_encrypted_json_bound_to_key } from '@/services/shared/encrypted-state-reader';

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
