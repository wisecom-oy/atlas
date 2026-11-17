import { describe, expect, it } from 'vitest';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import { as_root_refusal, RootRefusal } from '@/services/backup/root-refusal';

describe('as_root_refusal', () => {
  it('keeps the Graph status, code and message in the refusal', async () => {
    const refused = as_root_refusal(() =>
      Promise.reject(graph_error(400, 'BadRequest', 'Invalid root id')),
    );

    await expect(refused).rejects.toBeInstanceOf(RootRefusal);
    await expect(refused).rejects.toThrow(/400.*BadRequest.*Invalid root id/);
  });
});
