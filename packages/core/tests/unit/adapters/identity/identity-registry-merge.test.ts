import { describe, expect, it } from 'vitest';
import type { IdentityRegistry, IdentityRegistryEntry } from '@wisecom/atlas-types';
import { merge_active_identity } from '@/adapters/identity/identity-registry-merge';

const TENANT = 'tenant-abc';
const NOW = '2026-01-01T00:00:00.000Z';

function entry(email: string, object_id: string, status: 'active' | 'recycled' = 'active') {
  return {
    object_id,
    email,
    display_name: 'John Doe',
    registered_at: '2025-01-01T00:00:00.000Z',
    status,
  } satisfies IdentityRegistryEntry;
}

function registry(...entries: IdentityRegistryEntry[]): IdentityRegistry {
  return { tenant_id: TENANT, entries };
}

const JOHN = { object_id: 'oid-john', display_name: 'John Doe', email: ' John.Doe@Example.com ' };

describe('merge_active_identity', () => {
  it('creates the registry when none is stored', () => {
    const result = merge_active_identity(undefined, TENANT, JOHN, NOW);

    expect(result.outcome).toEqual({ kind: 'registered' });
    expect(result.registry.entries).toEqual([
      { ...entry('john.doe@example.com', 'oid-john'), registered_at: NOW },
    ]);
  });

  it('keeps entries another writer added and appends the new one', () => {
    const stored = registry(entry('jane.roe@example.com', 'oid-jane'));

    const result = merge_active_identity(stored, TENANT, JOHN, NOW);

    expect(result.registry.entries.map((e) => e.object_id)).toEqual(['oid-jane', 'oid-john']);
  });

  it('reports unchanged when the identity is already the active entry for its email', () => {
    const stored = registry(entry('john.doe@example.com', 'oid-john'));

    const result = merge_active_identity(stored, TENANT, JOHN, NOW);

    expect(result.outcome).toEqual({ kind: 'unchanged' });
    expect(result.registry).toBe(stored);
  });

  it('recycles the previous active owner of a reused email', () => {
    const stored = registry(
      entry('john.doe@example.com', 'oid-old', 'recycled'),
      entry('john.doe@example.com', 'oid-prev'),
    );

    const result = merge_active_identity(stored, TENANT, JOHN, NOW);

    expect(result.outcome).toEqual({ kind: 'recycled', previous_object_id: 'oid-prev' });
    const active = result.registry.entries.filter((e) => e.status === 'active');
    expect(active.map((e) => e.object_id)).toEqual(['oid-john']);
    expect(result.registry.entries).toHaveLength(3);
  });

  it('does not mutate the stored registry', () => {
    const stored = registry(entry('john.doe@example.com', 'oid-prev'));

    merge_active_identity(stored, TENANT, JOHN, NOW);

    expect(stored.entries).toEqual([entry('john.doe@example.com', 'oid-prev')]);
  });
});
