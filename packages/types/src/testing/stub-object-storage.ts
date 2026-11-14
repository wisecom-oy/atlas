import type { ObjectStorage } from '@/ports/storage/object-storage.port';
import { Readable } from 'node:stream';

/**
 * An in-memory bucket over `objects`, keyed by object key and mutated by `put`.
 *
 * Covers only `exists`, `get`, `get_stream`, `put` and `list`; a missing key raises `NoSuchKey`.
 */
export function stub_object_storage(objects: Record<string, Buffer> = {}): ObjectStorage {
  const get = async (key: string): Promise<Buffer> => {
    const blob = objects[key];
    if (!blob) throw Object.assign(new Error(`missing ${key}`), { name: 'NoSuchKey' });
    return blob;
  };
  return {
    exists: async (key: string) => key in objects,
    get,
    get_stream: async (key: string) => Readable.from([await get(key)]),
    put: async (key: string, data: Buffer) => {
      objects[key] = data;
    },
    list: async (prefix: string, limit?: number) => {
      const matched = Object.keys(objects)
        .sort()
        .filter((k) => k.startsWith(prefix));
      return limit === undefined ? matched : matched.slice(0, limit);
    },
  } as unknown as ObjectStorage;
}
