/**
 * Issue #624: a small-file PUT under conflict behaviour `rename` that Graph committed before
 * answering 5xx, or before the attempt timed out, came back on retry as "name (1).ext". Only
 * `replace` lands a repeated PUT on the same item, so only it is retried.
 */
import type { Client } from '@microsoft/microsoft-graph-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graph_error, stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import { graph_onedrive_upload_small_file } from '@/adapters/graph-onedrive-restore.adapter';

const OWNER = 'user@example.com';

/** A drive that keeps every PUT, then answers the way `respond` does. */
function committing_drive(respond: (written: number) => unknown) {
  const written: string[] = [];
  const graph = stub_graph_client((call) => {
    written.push(call.url);
    return respond(written.length);
  });
  return { client: graph.client as unknown as Client, written };
}

function upload(client: Client, conflict_behavior: string): Promise<unknown> {
  return graph_onedrive_upload_small_file(
    client,
    OWNER,
    'drive-1',
    'root',
    'report.txt',
    Buffer.from('hello'),
    conflict_behavior,
  ).catch((e: unknown) => e);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('graph_onedrive_upload_small_file after an ambiguous failure', () => {
  it.each(['rename', 'fail'])(
    'writes once under %s when Graph answers 503 after storing the file',
    async (conflict) => {
      const { client, written } = committing_drive((count) => {
        if (count === 1) throw graph_error(503, 'ServiceUnavailable');
        return { id: `item-${count}` };
      });

      const outcome = upload(client, conflict);
      await vi.advanceTimersByTimeAsync(600_000);

      expect(await outcome).toMatchObject({ statusCode: 503 });
      expect(written).toHaveLength(1);
    },
  );

  it('writes once under rename when the attempt times out', async () => {
    const { client, written } = committing_drive((count) =>
      count === 1 ? Promise.withResolvers<unknown>().promise : { id: `item-${count}` },
    );

    const outcome = upload(client, 'rename');
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toMatchObject({ code: 'ETIMEDOUT' });
    expect(written).toHaveLength(1);
  });

  it('retries under replace, where a second PUT overwrites the same item', async () => {
    const { client, written } = committing_drive((count) => {
      if (count === 1) throw graph_error(503, 'ServiceUnavailable');
      return { id: 'item-1' };
    });

    const outcome = upload(client, 'replace');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await outcome).toBeUndefined();
    expect(written).toHaveLength(2);
  });
});
