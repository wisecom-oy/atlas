import { describe, expect, it } from 'vitest';
import type { TeamsThread } from '@wisecom/atlas-types';
import { channel_folder_name } from '@/services/save/archive-layout';
import { message_ref, put_blob, put_message, TEAM, TIMESTAMP } from './save-harness';
import {
  IMAGE_BASE64,
  SNAPSHOT,
  TENANT,
  build_service,
  channel_entry,
  channel_shard,
  collecting_writable,
  snapshot_index,
  store,
} from './save-service-harness';
import { read_zip_entries } from './zip-reader';

const CHANNEL = 'channel-c';
const FOLDER = channel_folder_name(CHANNEL, 'Support');
const DIRECTORY = `channels/${FOLDER}`;

/** One channel with one plain message, and the channel-level data the shard carries. */
function channel_contents_fixture() {
  const bucket = new Map<string, Buffer>();
  const root = put_message(bucket, store, 'root-c', {
    id: 'root-c',
    createdDateTime: TIMESTAMP,
    body: { contentType: 'text', content: 'hello' },
  });
  const shard = channel_shard(
    CHANNEL,
    'Support',
    { 'root-c': { root: message_ref(root), replies: {} } },
    {
      members: [{ id: 'member-1', displayName: 'Member One', roles: ['owner'] }],
      tabs: [{ id: 'tab-1', displayName: 'Wiki', teamsApp: { id: 'app-1' } }],
      files_folder: {
        drive_id: 'drive-1',
        item_id: 'item-1',
        web_url: 'https://contoso.example/f',
      },
      shared_with_teams: [{ id: 'partner-team', displayName: 'Partner Team' }],
    },
  );
  const shards = new Map([[`shard/${CHANNEL}`, shard]]);
  const index = snapshot_index([channel_entry(CHANNEL, 'Support')]);
  return { bucket, index, shards };
}

/**
 * One message whose body shows an image the backup stored and one it never captured, and whose
 * hosted contents include a text object, the kind an attachment or card references.
 */
function hosted_fixture() {
  const bucket = new Map<string, Buffer>();
  const png = put_blob(bucket, store, 'img-h1', 'PNGDATA');
  const code = put_blob(bucket, store, 'code-h', 'print(1)');
  const root = put_message(bucket, store, 'root-h', {
    id: 'root-h',
    createdDateTime: TIMESTAMP,
    body: {
      contentType: 'html',
      content:
        '<p>see</p>' +
        '<img src="https://graph.test/messages/root-h/hostedContents/h1/$value">' +
        '<img src="https://graph.test/messages/root-h/hostedContents/h2/$value">',
    },
  });
  const thread: TeamsThread = {
    root: message_ref(root, {
      hosted: {
        h1: { ...png, content_type: 'image/png' },
        code: { ...code, content_type: 'text/plain' },
      },
      hosted_missing: ['h2'],
    }),
    replies: {},
  };
  const shards = new Map([
    [`shard/${CHANNEL}`, channel_shard(CHANNEL, 'Support', { 'root-h': thread })],
  ]);
  const index = snapshot_index([channel_entry(CHANNEL, 'Support')]);
  return { bucket, index, shards };
}

describe('TeamsSaveService channel contents', () => {
  it('writes members, tabs, the files folder and shared-with teams into messages.json', async () => {
    const { bucket, index, shards } = channel_contents_fixture();
    const sink = collecting_writable();

    await build_service(index, shards, bucket).save_snapshot(TENANT, TEAM, {
      snapshot_id: SNAPSHOT,
      output: sink.stream,
    });

    const document = JSON.parse(
      read_zip_entries(sink.bytes()).get(`${DIRECTORY}/messages.json`)?.toString('utf-8') ?? '{}',
    );
    expect(document.members).toEqual([
      { id: 'member-1', displayName: 'Member One', roles: ['owner'] },
    ]);
    expect(document.members_from_team).toBe(false);
    expect(document.tabs).toEqual([
      { id: 'tab-1', displayName: 'Wiki', teamsApp: { id: 'app-1' } },
    ]);
    expect(document.files_folder).toEqual({
      drive_id: 'drive-1',
      item_id: 'item-1',
      web_url: 'https://contoso.example/f',
    });
    expect(document.files_folder_unavailable).toBe(false);
    expect(document.shared_with_teams).toEqual([
      { id: 'partner-team', displayName: 'Partner Team' },
    ]);
    expect(document.threads).toHaveLength(1);
  });

  it('writes a non-image hosted object as its own file and points messages.json at it', async () => {
    const { bucket, index, shards } = hosted_fixture();
    const sink = collecting_writable();

    const result = await build_service(index, shards, bucket).save_snapshot(TENANT, TEAM, {
      snapshot_id: SNAPSHOT,
      output: sink.stream,
    });

    const entries = read_zip_entries(sink.bytes());
    expect(entries.get(`${DIRECTORY}/hosted/root-h/code.txt`)?.toString('utf-8')).toBe('print(1)');
    expect(entries.get(`${DIRECTORY}/hosted/root-h/h1.png`)?.toString('utf-8')).toBe('PNGDATA');
    const document = JSON.parse(
      entries.get(`${DIRECTORY}/messages.json`)?.toString('utf-8') ?? '{}',
    );
    expect(document.threads[0].root.hosted).toEqual([
      { id: 'h1', content_type: 'image/png', path: `${DIRECTORY}/hosted/root-h/h1.png` },
      { id: 'code', content_type: 'text/plain', path: `${DIRECTORY}/hosted/root-h/code.txt` },
    ]);
    expect(result.hosted_files).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it('lists a hosted content the backup never captured, keeps its source, and reports no error', async () => {
    const { bucket, index, shards } = hosted_fixture();
    const sink = collecting_writable();

    const result = await build_service(index, shards, bucket).save_snapshot(TENANT, TEAM, {
      snapshot_id: SNAPSHOT,
      output: sink.stream,
    });

    const entries = read_zip_entries(sink.bytes());
    const document = JSON.parse(
      entries.get(`${DIRECTORY}/messages.json`)?.toString('utf-8') ?? '{}',
    );
    expect(document.threads[0].root.hosted_missing).toEqual(['h2']);
    expect(result.hosted_missing).toEqual([
      'message root-h: hosted content h2 was not captured by backup',
    ]);
    expect(result.errors).toEqual([]);
    const page = entries.get(`${DIRECTORY}/index.html`)?.toString('utf-8') ?? '';
    expect(page).toContain(`src="data:image/png;base64,${IMAGE_BASE64}"`);
    expect(page).toContain('https://graph.test/messages/root-h/hostedContents/h2/$value');
  });
});
