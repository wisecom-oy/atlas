/* eslint-disable @typescript-eslint/naming-convention */
import { describe, it, expect, vi } from 'vitest';
import type { Container } from 'inversify';
import { create_outlook_api } from '@/outlook-api.factory';

/**
 * Issue #893. A host that never retries a restore automatically needs the exact items that may
 * exist in the target, so it can tell an operator what to check before rerunning. They are on
 * the SDK result as `outcomeUnknown`, camelised like the rest of it.
 */
describe('outlook restore outcomeUnknown', () => {
  it('returns the messages whose create may have committed in camelCase', async () => {
    const error =
      'msg-1: outcome unknown, the item may exist: the create request ended with HTTP 504';
    const restore_snapshot = vi.fn().mockResolvedValue({
      snapshot_id: 'snap-1',
      errors: [error],
      outcome_unknown: [
        { object_id: 'msg-1', target_folder_id: 'folder-1', error },
        { object_id: 'msg-2', target_folder_id: 'folder-1', attachment_name: 'a.pdf', error },
      ],
    });
    const container = {
      get: (token: symbol) =>
        ({ RestoreUseCase: { restore_snapshot } })[token.description as 'RestoreUseCase'] ?? {},
    } as unknown as Container;

    const result = await create_outlook_api('tenant-1', container).restore('snap-1');

    expect(result.outcomeUnknown).toEqual([
      { objectId: 'msg-1', targetFolderId: 'folder-1', error },
      { objectId: 'msg-2', targetFolderId: 'folder-1', attachmentName: 'a.pdf', error },
    ]);
  });
});
