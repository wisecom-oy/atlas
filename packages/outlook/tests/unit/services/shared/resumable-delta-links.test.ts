import { describe, it, expect } from 'vitest';
import type { MailboxDeltaCursor, Manifest } from '@wisecom/atlas-types';
import { resumable_delta_links } from '@/services/shared/resumable-delta-links';

const HEAD = { snapshot_id: 'snap-1', delta_links: { f1: 'manifest-link' } } as unknown as Manifest;
const legacy_links = (head: Manifest | undefined): Record<string, string> =>
  head?.delta_links ?? {};

function cursor(snapshot_id?: string): MailboxDeltaCursor {
  return {
    owner_id: 'john.doe@example.com',
    delta_links: { f1: 'cursor-link' },
    updated_at: '2026-08-17T00:00:00.000Z',
    ...(snapshot_id !== undefined ? { snapshot_id } : {}),
  };
}

describe('resumable_delta_links', () => {
  it('uses the cursor bound to the head', () => {
    expect(resumable_delta_links(cursor('snap-1'), HEAD, legacy_links)).toEqual({
      f1: 'cursor-link',
    });
  });

  it('yields no links for a cursor bound to a deleted snapshot, so status reports pending', () => {
    expect(resumable_delta_links(cursor('snap-2'), HEAD, legacy_links)).toEqual({});
  });

  it('yields no links for a cursor whose mailbox has no manifest', () => {
    expect(resumable_delta_links(cursor('snap-2'), undefined, legacy_links)).toEqual({});
    expect(resumable_delta_links(cursor(), undefined, legacy_links)).toEqual({});
  });

  it('falls back to the head manifest links when no cursor exists', () => {
    expect(resumable_delta_links(undefined, HEAD, legacy_links)).toEqual({ f1: 'manifest-link' });
  });
});
