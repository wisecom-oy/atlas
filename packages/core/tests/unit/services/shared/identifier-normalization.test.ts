import { describe, expect, it } from 'vitest';
import { normalize_owner_id, parse_team_id } from '@/services/shared/identifier-normalization';

const TEAM = '00000000-0000-0000-0000-00000000000a';

describe('normalize_owner_id', () => {
  it('lowercases a mixed-case object ID so two spellings share one prefix', () => {
    expect(normalize_owner_id('0000000A-0000-0000-0000-00000000000B')).toBe(
      '0000000a-0000-0000-0000-00000000000b',
    );
  });

  it('lowercases a mailbox address', () => {
    expect(normalize_owner_id('Jane.Doe@Contoso.com')).toBe('jane.doe@contoso.com');
  });

  it('does not trim, so two distinct values never merge', () => {
    expect(normalize_owner_id(' abc ')).toBe(' abc ');
  });
});

describe('parse_team_id', () => {
  it('trims surrounding whitespace and lowercases a GUID', () => {
    expect(parse_team_id(`\t ${TEAM.toUpperCase()} \n`)).toBe(TEAM);
  });

  it.each([
    '',
    '   ',
    'team-1',
    `${TEAM}0`,
    `{${TEAM}}`,
    `${TEAM}/channels`,
    `https://graph.microsoft.com/v1.0/teams/${TEAM}`,
  ])('returns undefined for %j, which is not a GUID', (value) => {
    expect(parse_team_id(value)).toBeUndefined();
  });
});
