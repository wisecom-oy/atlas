import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Container } from 'inversify';
import { SAVE_USE_CASE_TOKEN, ONEDRIVE_SAVE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { create_outlook_api } from '@/outlook-api.factory';
import { create_onedrive_api } from '@/onedrive-api.factory';

/**
 * Issue #44: an export can be streamed. The boundary converts option names, and a stream is not
 * data: cloning it or renaming its members would hand the service something that no longer writes
 * to the caller's destination.
 */
const TENANT = '00000000-0000-0000-0000-000000000000';

function container_with(token: symbol, service: unknown): Container {
  return {
    get: vi.fn((requested: symbol) => (requested === token ? service : {})),
  } as unknown as Container;
}

describe('save with a stream target', () => {
  it('hands the outlook service the caller stream itself', async () => {
    const sink = new PassThrough();
    const save_snapshot = vi.fn().mockResolvedValue({ output_path: '', saved_count: 1 });
    const api = create_outlook_api(TENANT, container_with(SAVE_USE_CASE_TOKEN, { save_snapshot }));

    const result = await api.save('snap-example-1', { output: sink });

    const options = save_snapshot.mock.calls[0]![2] as { output?: unknown };
    expect(options.output).toBe(sink);
    expect(result.outputPath).toBe('');
  });

  it('hands the drive services the caller stream itself', async () => {
    const sink = new PassThrough();
    const save_snapshot = vi.fn().mockResolvedValue({ output_path: '', files_saved: 1 });
    const api = create_onedrive_api(
      TENANT,
      container_with(ONEDRIVE_SAVE_USE_CASE_TOKEN, { save_snapshot }),
    );

    await api.save('11111111-1111-1111-1111-111111111111', {
      snapshotId: 'snap-example-1',
      output: sink,
    });

    const options = save_snapshot.mock.calls[0]![2] as { output?: unknown; snapshot_id?: string };
    expect(options.output).toBe(sink);
    expect(options.snapshot_id).toBe('snap-example-1');
  });
});
