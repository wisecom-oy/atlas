import { describe, expect, it } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import { normalize_team_id } from '@/services/shared/team-id';

const TEAM = '00000000-0000-0000-0000-000000000001';

describe('normalize_team_id', () => {
  it('trims and lowercases a GUID so every path shares one storage prefix (A9)', () => {
    expect(normalize_team_id(`  ${TEAM.toUpperCase()}  `)).toBe(TEAM);
  });

  it.each(['', 'team-1', 'https://graph.microsoft.com/v1.0/teams/' + TEAM, `${TEAM}/channels`])(
    'rejects %j, which is not a GUID (A9)',
    (value) => {
      expect(() => normalize_team_id(value)).toThrow(ConfigError);
    },
  );

  it('names the rejected value in the error message', () => {
    expect(() => normalize_team_id('team-1')).toThrow('Teams team id must be a GUID, got "team-1"');
  });
});
