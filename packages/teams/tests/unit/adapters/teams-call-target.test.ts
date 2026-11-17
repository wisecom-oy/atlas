import { describe, expect, it } from 'vitest';
import { channel_id_of_call, team_id_of_call } from '@/adapters/teams-call-target';

describe('team_id_of_call and channel_id_of_call', () => {
  it('reads the team and channel from plain id arguments', () => {
    const args = ['tenant', 'team-1', 'chan-1'];

    expect(team_id_of_call(args)).toBe('team-1');
    expect(channel_id_of_call(args)).toBe('chan-1');
  });

  it('reads the team and channel from a message locator', () => {
    const args = ['tenant', { team_id: 'team-1', channel_id: 'chan-1', message_id: 'm' }];

    expect(team_id_of_call(args)).toBe('team-1');
    expect(channel_id_of_call(args)).toBe('chan-1');
  });

  it('reads the channel from the locator when a hosted content id follows it', () => {
    const args = ['tenant', { team_id: 'team-1', channel_id: 'chan-1', root_id: 'm' }, 'hosted-1'];

    expect(channel_id_of_call(args)).toBe('chan-1');
  });

  it('returns undefined when the call names no team or channel', () => {
    expect(team_id_of_call(['tenant'])).toBeUndefined();
    expect(channel_id_of_call(['tenant', 42])).toBeUndefined();
  });
});
