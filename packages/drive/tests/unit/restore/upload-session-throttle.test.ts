import { afterEach, describe, expect, it, vi } from 'vitest';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  recording_throttle_coordinator,
  type RecordingThrottleCoordinator,
} from '@wisecom/atlas-types/testing/recording-throttle-coordinator';
import { upload_content_to_session } from '@/restore/upload-session';

/**
 * Resumable upload chunks run outside a scoped connector call, so each chunk PUT is charged to
 * the sharepoint_onedrive pool of the ambient coordinator. A 429 must raise that cooldown, and
 * every attempt, including the retry, must wait on it first.
 */

const UPLOAD_URL = 'https://graph.test/upload/session-throttle';

/** Answers the first PUT with `first_put`, every later PUT with 201; GET and DELETE succeed. */
function stub_put_sequence(first_put: Response): void {
  let puts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method !== 'PUT') return new Response('{}', { status: 200 });
      puts += 1;
      return puts === 1 ? first_put : new Response('{}', { status: 201 });
    }),
  );
}

async function upload_under(coordinator: RecordingThrottleCoordinator): Promise<void> {
  await run_with_throttle_coordinator(coordinator, 'outlook', () =>
    upload_content_to_session(UPLOAD_URL, Buffer.alloc(16, 1), 'Report.docx'),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('upload_content_to_session throttling (issue #571)', () => {
  it('waits before each attempt and raises the transfer cooldown from a 429 Retry-After', async () => {
    vi.useFakeTimers();
    stub_put_sequence(new Response('', { status: 429, headers: { 'Retry-After': '2' } }));
    const coordinator = recording_throttle_coordinator();

    const upload = upload_under(coordinator);
    await vi.advanceTimersByTimeAsync(2_000);
    await upload;

    expect(coordinator.waits).toEqual(['sharepoint_onedrive', 'sharepoint_onedrive']);
    expect(coordinator.raises).toEqual([['sharepoint_onedrive', 2_000]]);
  });

  it('completes the upload when the coordinator rejects on wait (fail open)', async () => {
    stub_put_sequence(new Response('{}', { status: 201 }));
    const coordinator = recording_throttle_coordinator();
    coordinator.wait = async () => {
      throw new Error('shared state unavailable');
    };

    await expect(upload_under(coordinator)).resolves.toBeUndefined();
    expect(coordinator.raises).toEqual([]);
  });
});
