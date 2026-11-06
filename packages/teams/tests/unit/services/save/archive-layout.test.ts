import { describe, expect, it } from 'vitest';
import type { TeamsSnapshotIndex } from '@wisecom/atlas-types';
import {
  channel_document,
  channel_folder_name,
  team_document,
  type ExportedChannel,
} from '@/services/save/archive-layout';

const INDEX = {
  snapshot_id: 'snap-1',
  created_at: '2025-01-01T00:00:00.000Z',
  team: { id: 'team-1', displayName: 'Team One' },
  members: [{ id: 'm1' }],
  channels: [],
  totals: { thread_count: 0, message_count: 0, size_bytes: 0 },
} as unknown as TeamsSnapshotIndex;

describe('channel_folder_name', () => {
  it('turns a display name into a readable ASCII folder with an id prefix', () => {
    expect(channel_folder_name('19:abcdef0123456789xyz@thread', 'General Chat!')).toBe(
      'General-Chat-19abcdef0123',
    );
  });

  it('never yields a path separator or dot segment', () => {
    const folder = channel_folder_name('chan-1', '../../etc/passwd');

    expect(folder).toBe('etc-passwd-chan1');
    expect(folder).not.toMatch(/[/\\.]/);
  });

  it('keeps channels with the same display name in different folders', () => {
    const first = channel_folder_name('aaaa-1111', 'Same');
    const second = channel_folder_name('bbbb-2222', 'Same');

    expect(first).not.toBe(second);
  });

  it('falls back to a fixed name when the display name has no usable characters', () => {
    expect(channel_folder_name('zz-9', '!!!')).toBe('channel-zz9');
    expect(channel_folder_name('zz-9', undefined)).toBe('channel-zz9');
  });

  it('caps the readable part at 60 characters', () => {
    const folder = channel_folder_name('c1', 'a'.repeat(200));

    expect(folder).toBe(`${'a'.repeat(60)}-c1`);
  });
});

describe('team_document', () => {
  it('lists only the channels this archive holds', () => {
    const saved: ExportedChannel[] = [
      {
        folder: 'General-c1',
        entry: {
          channel_id: 'c1',
          display_name: 'General',
          shard_key: 'k',
          shard_checksum: 'x',
          thread_count: 2,
          message_count: 5,
          size_bytes: 10,
        },
      },
    ];

    const document = JSON.parse(team_document(INDEX, saved));

    expect(document.snapshot_id).toBe('snap-1');
    expect(document.team).toEqual({ id: 'team-1', displayName: 'Team One' });
    expect(document.channels).toEqual([
      {
        channel_id: 'c1',
        display_name: 'General',
        folder: 'General-c1',
        thread_count: 2,
        message_count: 5,
        deleted_at: undefined,
      },
    ]);
  });
});

describe('channel_document', () => {
  it('nests replies under their root and keeps the kept-version marker', () => {
    const document = JSON.parse(
      channel_document('team-1', 'c1', { id: 'c1', displayName: 'General' }, [
        {
          root: {
            id: 'r1',
            author: 'A',
            created_at: '2025-01-01T00:00:00.000Z',
            deleted_at: '2025-01-02T00:00:00.000Z',
            kept_version: true,
            content: { id: 'r1' },
            html: '<p>x</p>',
          },
          replies: [
            {
              id: 'p1',
              author: 'B',
              created_at: '2025-01-01T01:00:00.000Z',
              kept_version: false,
              content: { id: 'p1' },
              html: '<p>y</p>',
            },
          ],
        },
      ]),
    );

    expect(document.channel).toEqual({ id: 'c1', displayName: 'General' });
    expect(document.threads).toHaveLength(1);
    expect(document.threads[0].root.id).toBe('r1');
    expect(document.threads[0].root.kept_version).toBe(true);
    expect(document.threads[0].root.message).toEqual({ id: 'r1' });
    expect(document.threads[0].replies[0].id).toBe('p1');
    expect(document.threads[0].replies[0].kept_version).toBe(false);
  });
});
