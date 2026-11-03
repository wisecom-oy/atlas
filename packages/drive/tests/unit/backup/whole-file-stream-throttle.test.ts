import { afterEach, describe, expect, it, vi } from 'vitest';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  recording_throttle_coordinator,
  type RecordingThrottleCoordinator,
} from '@wisecom/atlas-types/testing/recording-throttle-coordinator';
import { stream_whole_file_in_chunks } from '@/backup/whole-file-stream';

/**
 * Large-file downloads run outside a scoped connector call, so the transfer helpers charge them
 * to the sharepoint_onedrive pool of the ambient coordinator. A 429 from the CDN must raise that
 * pool's cooldown, and every attempt must wait on it first.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

async function collect_under(
  coordinator: RecordingThrottleCoordinator,
  url: string,
): Promise<Buffer[]> {
  const parts: Buffer[] = [];
  await run_with_throttle_coordinator(coordinator, 'outlook', async () => {
    for await (const chunk of stream_whole_file_in_chunks(url, 'item-1', {
      chunk_size_bytes: 4,
      stall_timeout_ms: 30_000,
    })) {
      parts.push(chunk);
    }
  });
  return parts;
}

describe('stream_whole_file_in_chunks throttling (issue #571)', () => {
  it('waits on the transfer pool before the request and passes a 200 body through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(Buffer.from('abcdefgh'))),
    );
    const coordinator = recording_throttle_coordinator();

    const parts = await collect_under(coordinator, 'https://cdn.test/ok');

    expect(Buffer.concat(parts).toString()).toBe('abcdefgh');
    expect(coordinator.waits).toEqual(['sharepoint_onedrive']);
    expect(coordinator.raises).toEqual([]);
  });

  it('raises the transfer pool cooldown from a 429 Retry-After and fails the download', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 429, headers: { 'Retry-After': '12' } })),
    );
    const coordinator = recording_throttle_coordinator();

    await expect(collect_under(coordinator, 'https://cdn.test/throttled')).rejects.toThrow();

    expect(coordinator.waits).toEqual(['sharepoint_onedrive']);
    expect(coordinator.raises).toEqual([['sharepoint_onedrive', 12_000]]);
  });

  it('still downloads when the coordinator rejects on wait (fail open)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(Buffer.from('abcd'))),
    );
    const coordinator = recording_throttle_coordinator();
    coordinator.wait = async () => {
      throw new Error('shared state unavailable');
    };

    const parts = await collect_under(coordinator, 'https://cdn.test/fail-open');

    expect(Buffer.concat(parts).toString()).toBe('abcd');
  });
});
