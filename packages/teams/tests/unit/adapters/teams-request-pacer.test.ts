import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-types';
import {
  DEFAULT_TEAMS_PACING_RATES,
  TeamsRequestPacer,
  type PacedRequest,
  type TeamsPacingRates,
} from '@/adapters/teams-request-pacer';

/** Rates where every lane is unlimited (zero interval), so a test only pins the lane it names. */
function rates(overrides: Partial<TeamsPacingRates>): Partial<TeamsPacingRates> {
  return {
    tenant_messages_rps: Infinity,
    tenant_default_rps: Infinity,
    team_rps: Infinity,
    channel_rps: Infinity,
    ...overrides,
  };
}

/** Resolves with the fake-clock time at which the request got its slot. */
function acquire_at(
  pacer: TeamsRequestPacer,
  request: PacedRequest,
  signal?: AbortSignal,
): Promise<number> {
  return pacer.acquire(request, signal).then(() => Date.now());
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DEFAULT_TEAMS_PACING_RATES', () => {
  it('paces each lane at 80% of the Graph Teams limit it guards', () => {
    expect(DEFAULT_TEAMS_PACING_RATES.tenant_messages_rps).toBeCloseTo(
      GRAPH_SERVICE_LIMITS.teams.messages_requests_per_second * 0.8,
    );
    expect(DEFAULT_TEAMS_PACING_RATES.tenant_default_rps).toBeCloseTo(
      GRAPH_SERVICE_LIMITS.teams.team_requests_per_second * 0.8,
    );
    expect(DEFAULT_TEAMS_PACING_RATES.team_rps).toBeCloseTo(
      GRAPH_SERVICE_LIMITS.teams.team_requests_per_second_per_team * 0.8,
    );
    expect(DEFAULT_TEAMS_PACING_RATES.channel_rps).toBeCloseTo(
      GRAPH_SERVICE_LIMITS.teams.messages_requests_per_second_per_channel * 0.8,
    );
  });
});

describe('TeamsRequestPacer', () => {
  it('spaces requests on the tenant messages lane by its interval', async () => {
    const pacer = new TeamsRequestPacer(rates({ tenant_messages_rps: 2 }));
    const origin = Date.now();
    const times = ['chan-1', 'chan-2', 'chan-3'].map((channel_id) =>
      acquire_at(pacer, { request_class: 'messages', tenant_id: 't1', channel_id }),
    );

    await vi.advanceTimersByTimeAsync(2000);

    expect((await Promise.all(times)).map((time) => time - origin)).toEqual([0, 500, 1000]);
  });

  it('holds a second request to one channel for the channel lane, not other channels', async () => {
    const pacer = new TeamsRequestPacer(rates({ channel_rps: 1 }));
    const origin = Date.now();
    const in_channel = (channel_id: string): PacedRequest => ({
      request_class: 'messages',
      tenant_id: 't1',
      team_id: 'x',
      channel_id,
    });
    const same_channel = [acquire_at(pacer, in_channel('c1')), acquire_at(pacer, in_channel('c1'))];
    const other_channel = acquire_at(pacer, in_channel('c2'));

    await vi.advanceTimersByTimeAsync(2000);

    const [first, second] = await Promise.all(same_channel);
    expect(first! - origin).toBe(0);
    expect(second! - origin).toBe(1000);
    expect((await other_channel) - origin).toBe(0);
  });

  it('spaces default requests to one team by its lane, and leaves other teams alone', async () => {
    const pacer = new TeamsRequestPacer(rates({ team_rps: 2 }));
    const origin = Date.now();
    const team_one = [
      acquire_at(pacer, { request_class: 'default', tenant_id: 't1', team_id: 'a' }),
      acquire_at(pacer, { request_class: 'default', tenant_id: 't1', team_id: 'a' }),
    ];
    const team_two = acquire_at(pacer, { request_class: 'default', tenant_id: 't1', team_id: 'b' });

    await vi.advanceTimersByTimeAsync(2000);

    const [first, second] = await Promise.all(team_one);
    expect(first! - origin).toBe(0);
    expect(second! - origin).toBe(500);
    expect((await team_two) - origin).toBe(0);
  });

  it('keeps the messages class and the default class on separate tenant lanes', async () => {
    const pacer = new TeamsRequestPacer(rates({ tenant_default_rps: 1 }));
    const origin = Date.now();
    const default_request = acquire_at(pacer, { request_class: 'default', tenant_id: 't1' });
    const messages_request = acquire_at(pacer, {
      request_class: 'messages',
      tenant_id: 't1',
      team_id: 'x',
      channel_id: 'c1',
    });

    await vi.advanceTimersByTimeAsync(2000);

    expect((await default_request) - origin).toBe(0);
    expect((await messages_request) - origin).toBe(0);
  });

  it('keeps lanes apart when ids contain the separators a naive key would join on', async () => {
    const pacer = new TeamsRequestPacer(rates({ team_rps: 1 }));
    const origin = Date.now();
    // Both requests would share a lane if the key were the parts joined with commas.
    const first = acquire_at(pacer, { request_class: 'default', tenant_id: 't', team_id: '1,2' });
    const second = acquire_at(pacer, { request_class: 'default', tenant_id: 't,1', team_id: '2' });

    await vi.advanceTimersByTimeAsync(2000);

    expect((await first) - origin).toBe(0);
    expect((await second) - origin).toBe(0);
  });

  it('gives a cancelled reservation back so the next request takes that slot', async () => {
    const pacer = new TeamsRequestPacer(rates({ tenant_default_rps: 1 }));
    const request: PacedRequest = { request_class: 'default', tenant_id: 't1' };
    const origin = Date.now();
    await pacer.acquire(request);
    const controller = new AbortController();
    const cancelled = pacer.acquire(request, controller.signal);

    controller.abort(new Error('run stopped'));
    await expect(cancelled).rejects.toThrow('run stopped');
    const next = acquire_at(pacer, request);
    await vi.advanceTimersByTimeAsync(2000);

    expect((await next) - origin).toBe(1000);
  });
});
