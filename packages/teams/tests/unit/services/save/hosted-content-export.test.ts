import { describe, expect, it } from 'vitest';
import type { TeamsHostedRef } from '@wisecom/atlas-types';
import { stub_encrypted_object_store } from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { export_hosted_contents } from '@/services/save/hosted-content-export';
import { put_blob, stub_save_context, thread_context } from './save-harness';

const DIRECTORY = 'channels/Team-c1';
const OWNER = { root_id: 'root-1' };

describe('export_hosted_contents', () => {
  it('writes every hosted object as a file and reads image types into data URIs', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const ctx = stub_save_context(store, bucket);
    const image = put_blob(bucket, store, 'k-img', 'PNGDATA');
    const code = put_blob(bucket, store, 'k-code', 'const x = 1;');
    const hosted: Record<string, TeamsHostedRef> = {
      img: { ...image, content_type: 'image/png' },
      code: { ...code, content_type: 'text/plain' },
    };
    const { context, tally, entries } = thread_context(ctx, DIRECTORY);

    const out = await export_hosted_contents(context, OWNER, hosted, []);

    expect([...entries.keys()].sort()).toEqual([
      `${DIRECTORY}/hosted/root-1/code.txt`,
      `${DIRECTORY}/hosted/root-1/img.png`,
    ]);
    expect(entries.get(`${DIRECTORY}/hosted/root-1/code.txt`)?.toString('utf-8')).toBe(
      'const x = 1;',
    );
    expect(out.files).toEqual([
      { id: 'img', content_type: 'image/png', path: `${DIRECTORY}/hosted/root-1/img.png` },
      { id: 'code', content_type: 'text/plain', path: `${DIRECTORY}/hosted/root-1/code.txt` },
    ]);
    expect(out.data_uris.get('img')).toBe(
      `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`,
    );
    expect(out.data_uris.has('code')).toBe(false);
    expect(tally.hosted_files).toBe(2);
    expect(tally.errors).toEqual([]);
  });

  it('reports an unreadable hosted object, writes no file for it, and keeps the others', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const ctx = stub_save_context(store, bucket);
    const good = put_blob(bucket, store, 'k-good', 'ok');
    const broken = put_blob(bucket, store, 'k-broken', 'bad');
    bucket.delete('k-broken');
    const hosted: Record<string, TeamsHostedRef> = {
      good: { ...good, content_type: 'text/plain' },
      broken: { ...broken, content_type: 'text/plain' },
    };
    const { context, tally, entries } = thread_context(ctx, DIRECTORY);

    const out = await export_hosted_contents(context, OWNER, hosted, []);

    expect(out.files.map((file) => file.id)).toEqual(['good']);
    expect([...entries.keys()]).toEqual([`${DIRECTORY}/hosted/root-1/good.txt`]);
    expect(tally.errors).toHaveLength(1);
    expect(tally.errors[0]).toContain('message root-1: hosted content broken');
    expect(tally.hosted_files).toBe(1);
  });

  it('lists each hosted content the backup never captured, without a file or an error', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const ctx = stub_save_context(store, bucket);
    const { context, tally, entries } = thread_context(ctx, DIRECTORY);

    const out = await export_hosted_contents(
      context,
      { root_id: 'root-1', reply_id: 'reply-2' },
      {},
      ['h7'],
    );

    expect(out.missing).toEqual(['h7']);
    expect(tally.hosted_missing).toEqual([
      'reply reply-2: hosted content h7 was not captured by backup',
    ]);
    expect(entries.size).toBe(0);
    expect(tally.errors).toEqual([]);
  });
});
