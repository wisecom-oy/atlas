import { describe, expect, it } from 'vitest';
import { NotFoundError } from '@wisecom/atlas-types';
import { TeamsSaveService } from '@/services/save/save.service';
import { TEAM } from './save-harness';
import {
  IMAGE_BASE64,
  SNAPSHOT,
  TENANT,
  build_service,
  collecting_writable,
  fixture,
} from './save-service-harness';
import { read_zip_entries } from './zip-reader';

describe('TeamsSaveService', () => {
  it('writes team.json, messages.json and index.html per channel, and the hosted file', async () => {
    const { bucket, index, shards } = fixture();
    const service = build_service(index, shards, bucket);
    const sink = collecting_writable();

    const result = await service.save_snapshot(TENANT, TEAM, {
      snapshot_id: SNAPSHOT,
      output: sink.stream,
    });

    const names = [...read_zip_entries(sink.bytes()).keys()].sort();
    expect(names).toEqual(
      [
        'team.json',
        'channels/General-channel1/index.html',
        'channels/General-channel1/messages.json',
        'channels/General-channel1/hosted/root-1/h1.png',
        'channels/Random-channel2/index.html',
        'channels/Random-channel2/messages.json',
      ].sort(),
    );
    expect(result.channels_saved).toBe(2);
    expect(result.messages_saved).toBe(3);
    expect(result.hosted_files).toBe(1);
    expect(result.hosted_missing).toEqual([]);
    expect(result.interrupted).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('sanitizes bodies, inlines images, and shows kept deleted versions', async () => {
    const { bucket, index, shards } = fixture();
    const service = build_service(index, shards, bucket);
    const sink = collecting_writable();

    const result = await service.save_snapshot(TENANT, TEAM, {
      snapshot_id: SNAPSHOT,
      channel_id: 'channel-1',
      output: sink.stream,
    });

    const entries = read_zip_entries(sink.bytes());
    const page = entries.get('channels/General-channel1/index.html')?.toString('utf-8') ?? '';
    expect(page).toMatch(/<meta[^>]*Content-Security-Policy/i);
    expect(page).toContain("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(page).toContain(`src="data:image/png;base64,${IMAGE_BASE64}"`);
    expect(page).not.toMatch(/<script|onclick|onerror|<meta http-equiv="refresh"|<base href/i);
    expect(page).toContain('last live text');
    expect(page).toContain('Deleted (last version shown)');
    expect(result.images_inlined).toBe(1);
    expect(result.channels_saved).toBe(1);
    expect(result.messages_saved).toBe(2);
  });

  it('reports a missing message blob without failing the export', async () => {
    const { bucket, index, shards } = fixture();
    bucket.delete('root-3');
    const service = build_service(index, shards, bucket);
    const sink = collecting_writable();

    const result = await service.save_snapshot(TENANT, TEAM, {
      snapshot_id: SNAPSHOT,
      output: sink.stream,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('message root-3');
    expect(result.messages_saved).toBe(2);
    expect(result.channels_saved).toBe(2);
    expect(read_zip_entries(sink.bytes()).has('team.json')).toBe(true);
  });

  it('saves only the requested channel and lists only that channel in team.json', async () => {
    const { bucket, index, shards } = fixture();
    const service = build_service(index, shards, bucket);
    const sink = collecting_writable();

    const result = await service.save_snapshot(TENANT, TEAM, {
      snapshot_id: SNAPSHOT,
      channel_id: 'channel-2',
      output: sink.stream,
    });

    const entries = read_zip_entries(sink.bytes());
    expect([...entries.keys()].some((name) => name.startsWith('channels/General'))).toBe(false);
    const team = JSON.parse(entries.get('team.json')?.toString('utf-8') ?? '{}');
    expect(team.channels.map((channel: { channel_id: string }) => channel.channel_id)).toEqual([
      'channel-2',
    ]);
    expect(result.channels_saved).toBe(1);
  });

  it('rejects a channel id that is not in the snapshot', async () => {
    const { bucket, index, shards } = fixture();
    const service = build_service(index, shards, bucket);
    const sink = collecting_writable();

    await expect(
      service.save_snapshot(TENANT, TEAM, {
        snapshot_id: SNAPSHOT,
        channel_id: 'no-such-channel',
        output: sink.stream,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a snapshot that does not exist for the team', async () => {
    const { bucket, shards } = fixture();
    const service = build_service(undefined, shards, bucket);
    const sink = collecting_writable();

    await expect(
      service.save_snapshot(TENANT, TEAM, { snapshot_id: SNAPSHOT, output: sink.stream }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('resolves from a container with only storage ports bound', () => {
    const service = build_service(undefined, new Map(), new Map());

    expect(service).toBeInstanceOf(TeamsSaveService);
  });
});
