import { describe, it, expect, vi } from 'vitest';
import type { Container } from 'inversify';
import { TEAMS_QUARANTINE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { create_teams_api } from '@/teams-api.factory';

const KEY = 'teams/manifests/00000000-0000-0000-0000-00000000abcd/teams-snap-2000-bbbbbb.json';

describe('atlas.teams.quarantine (issue #694)', () => {
  it('quarantines a key and returns the result in camelCase', async () => {
    const quarantine = {
      quarantine_unreadable_object: vi.fn(async () => ({
        storage_key: KEY,
        quarantine_key: `_quarantine/${KEY}`,
        kind: 'manifest',
        reason: 'The Teams snapshot index does not decrypt',
      })),
    };
    const container = {
      get: (token: symbol) => (token === TEAMS_QUARANTINE_USE_CASE_TOKEN ? quarantine : {}),
    } as unknown as Container;

    const result = await create_teams_api('tenant-1', container).quarantine(KEY);

    expect(quarantine.quarantine_unreadable_object).toHaveBeenCalledWith('tenant-1', KEY);
    expect(result).toEqual({
      storageKey: KEY,
      quarantineKey: `_quarantine/${KEY}`,
      kind: 'manifest',
      reason: 'The Teams snapshot index does not decrypt',
    });
  });
});
