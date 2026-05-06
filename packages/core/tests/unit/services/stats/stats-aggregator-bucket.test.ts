import { describe, it, expect } from 'vitest';
import { aggregate_bucket_stats } from '@/services/stats/stats-aggregator';
import { make_entry, make_manifest } from './stats-aggregator.fixtures';

describe('aggregate_bucket_stats', () => {
  it('returns zeroed stats for empty manifests', () => {
    const result = aggregate_bucket_stats('t', []);

    expect(result.tenant_id).toBe('t');
    expect(result.mailbox_count).toBe(0);
    expect(result.snapshot_count).toBe(0);
    expect(result.total_messages).toBe(0);
    expect(result.total_size_bytes).toBe(0);
    expect(result.attachment_count).toBe(0);
    expect(result.attachment_size_bytes).toBe(0);
    expect(result.monthly_breakdown).toEqual([]);
  });

  it('counts distinct mailboxes and sums across snapshots', () => {
    const manifests = [
      make_manifest({
        owner_id: 'alice@test.com',
        snapshot_id: 's1',
        entries: [make_entry({ size_bytes: 200 }), make_entry({ size_bytes: 300 })],
      }),
      make_manifest({
        owner_id: 'alice@test.com',
        snapshot_id: 's2',
        entries: [make_entry({ size_bytes: 150 })],
      }),
      make_manifest({
        owner_id: 'bob@test.com',
        snapshot_id: 's3',
        entries: [make_entry({ size_bytes: 400 })],
      }),
    ];

    const result = aggregate_bucket_stats('t', manifests);

    expect(result.mailbox_count).toBe(2);
    expect(result.snapshot_count).toBe(3);
    expect(result.total_messages).toBe(4);
    expect(result.total_size_bytes).toBe(1050);
  });

  it('accumulates attachment counts and sizes', () => {
    const manifests = [
      make_manifest({
        entries: [
          make_entry({
            size_bytes: 100,
            attachments: [
              {
                attachment_id: 'a1',
                name: 'f.pdf',
                content_type: 'application/pdf',
                size_bytes: 500,
                storage_key: 'att/x',
                checksum: 'x',
                is_inline: false,
              },
              {
                attachment_id: 'a2',
                name: 'g.png',
                content_type: 'image/png',
                size_bytes: 300,
                storage_key: 'att/y',
                checksum: 'y',
                is_inline: true,
              },
            ],
          }),
          make_entry({ size_bytes: 50 }),
        ],
      }),
    ];

    const result = aggregate_bucket_stats('t', manifests);

    expect(result.total_messages).toBe(2);
    expect(result.attachment_count).toBe(2);
    expect(result.attachment_size_bytes).toBe(800);
    expect(result.total_size_bytes).toBe(100 + 500 + 300 + 50);
  });

  it('builds monthly breakdown grouped and sorted', () => {
    const manifests = [
      make_manifest({
        created_at: new Date('2026-01-15'),
        entries: [make_entry({ size_bytes: 100 })],
      }),
      make_manifest({
        created_at: new Date('2026-03-10'),
        entries: [make_entry({ size_bytes: 200 })],
      }),
      make_manifest({
        created_at: new Date('2026-01-20'),
        entries: [make_entry({ size_bytes: 150 })],
      }),
    ];

    const result = aggregate_bucket_stats('t', manifests);

    expect(result.monthly_breakdown).toHaveLength(2);
    expect(result.monthly_breakdown[0]!.month).toBe('2026-01');
    expect(result.monthly_breakdown[0]!.snapshot_count).toBe(2);
    expect(result.monthly_breakdown[0]!.message_count).toBe(2);
    expect(result.monthly_breakdown[0]!.size_bytes).toBe(250);
    expect(result.monthly_breakdown[1]!.month).toBe('2026-03');
    expect(result.monthly_breakdown[1]!.snapshot_count).toBe(1);
    expect(result.monthly_breakdown[1]!.size_bytes).toBe(200);
  });
});
