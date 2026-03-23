import { describe, it, expect } from 'vitest';
import { aggregate_monthly_breakdown } from '@/services/stats/stats-aggregator';
import { make_entry, make_manifest } from './stats-aggregator.fixtures';

describe('aggregate_monthly_breakdown', () => {
  it('returns empty array for no manifests', () => {
    expect(aggregate_monthly_breakdown([])).toEqual([]);
  });

  it('groups manifests by YYYY-MM and sorts chronologically', () => {
    const manifests = [
      make_manifest({
        created_at: new Date('2026-03-15'),
        entries: [make_entry({ size_bytes: 100 })],
      }),
      make_manifest({
        created_at: new Date('2026-01-10'),
        entries: [make_entry({ size_bytes: 200 })],
      }),
      make_manifest({
        created_at: new Date('2026-03-20'),
        entries: [
          make_entry({
            size_bytes: 50,
            attachments: [
              {
                attachment_id: 'a1',
                name: 'f.pdf',
                content_type: 'application/pdf',
                size_bytes: 25,
                storage_key: 'att/z',
                checksum: 'z',
                is_inline: false,
              },
            ],
          }),
        ],
      }),
    ];

    const result = aggregate_monthly_breakdown(manifests);

    expect(result).toHaveLength(2);
    expect(result[0]!.month).toBe('2026-01');
    expect(result[0]!.snapshot_count).toBe(1);
    expect(result[0]!.message_count).toBe(1);
    expect(result[0]!.size_bytes).toBe(200);
    expect(result[0]!.attachment_count).toBe(0);

    expect(result[1]!.month).toBe('2026-03');
    expect(result[1]!.snapshot_count).toBe(2);
    expect(result[1]!.message_count).toBe(2);
    expect(result[1]!.size_bytes).toBe(175);
    expect(result[1]!.attachment_count).toBe(1);
    expect(result[1]!.attachment_size_bytes).toBe(25);
  });

  it('handles manifests with no entries', () => {
    const manifests = [make_manifest({ created_at: new Date('2026-06-01'), entries: [] })];

    const result = aggregate_monthly_breakdown(manifests);

    expect(result).toHaveLength(1);
    expect(result[0]!.month).toBe('2026-06');
    expect(result[0]!.snapshot_count).toBe(1);
    expect(result[0]!.message_count).toBe(0);
    expect(result[0]!.size_bytes).toBe(0);
  });
});
