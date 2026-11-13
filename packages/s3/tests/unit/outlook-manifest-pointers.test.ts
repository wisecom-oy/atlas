import { describe, expect, it } from 'vitest';
import type { Manifest } from '@wisecom/atlas-types';
import {
  find_newer_latest_pointer,
  type ManifestPointer,
} from '@/adapters/outlook-manifest-pointers';

const OWNER = 'user@test.com';
const NEWER_KEY = `manifests/${OWNER}/snap-new.json`;
const CREATED = new Date('2026-01-20T10:00:00Z');

function make_manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    owner_id: OWNER,
    snapshot_id: 'snap-written',
    created_at: CREATED,
    total_objects: 0,
    total_size_bytes: 0,
    delta_links: {},
    entries: [],
    ...overrides,
  };
}

function pointer_created_at(iso: string, manifest_key = NEWER_KEY): ManifestPointer {
  return { manifest_key, created_at: iso };
}

describe('find_newer_latest_pointer', () => {
  it('names the pointed snapshot when it was created after the manifest being written', () => {
    const newer = find_newer_latest_pointer(
      pointer_created_at('2026-01-21T00:00:00.000Z'),
      make_manifest(),
    );

    expect(newer).toEqual({
      snapshot_id: 'snap-new',
      created_at: new Date('2026-01-21T00:00:00.000Z'),
    });
  });

  it('names nothing when the pointed snapshot was created at the same time (replace wins a tie)', () => {
    expect(
      find_newer_latest_pointer(pointer_created_at(CREATED.toISOString()), make_manifest()),
    ).toBeUndefined();
  });

  it('names nothing when the pointed snapshot is older', () => {
    expect(
      find_newer_latest_pointer(pointer_created_at('2026-01-01T00:00:00.000Z'), make_manifest()),
    ).toBeUndefined();
  });

  it('names nothing when there is no pointer', () => {
    expect(find_newer_latest_pointer(undefined, make_manifest())).toBeUndefined();
  });

  it('names nothing for a pointer written before created_at existed', () => {
    expect(find_newer_latest_pointer({ manifest_key: NEWER_KEY }, make_manifest())).toBeUndefined();
  });

  it('names nothing when created_at is not a parseable date', () => {
    expect(
      find_newer_latest_pointer(pointer_created_at('not a date'), make_manifest()),
    ).toBeUndefined();
  });

  it('names nothing when created_at is not a string', () => {
    const numeric = { manifest_key: NEWER_KEY, created_at: 1 } as unknown as ManifestPointer;

    expect(find_newer_latest_pointer(numeric, make_manifest())).toBeUndefined();
  });

  it('names nothing when the pointed manifest belongs to another owner', () => {
    const other_owner = pointer_created_at(
      '2026-01-21T00:00:00.000Z',
      'manifests/other@test.com/snap-new.json',
    );

    expect(find_newer_latest_pointer(other_owner, make_manifest())).toBeUndefined();
  });

  it('names nothing when the pointed key is not a manifest key of this owner', () => {
    for (const manifest_key of [
      `manifests/${OWNER}/nested/snap.json`,
      `manifests/${OWNER}/snap-new.txt`,
      `manifests/${OWNER}/.json`,
      'elsewhere/snap-new.json',
    ]) {
      expect(
        find_newer_latest_pointer(
          pointer_created_at('2026-01-21T00:00:00.000Z', manifest_key),
          make_manifest(),
        ),
      ).toBeUndefined();
    }
  });
});
