import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const CENTRAL_SIGNATURE = 0x02014b50;
const DEFLATE = 8;

/**
 * Reads every entry of a zip written by a streaming archiver. Sizes and offsets come from the
 * central directory because streamed local headers carry zeros and a data descriptor instead.
 */
export function read_zip_entries(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.lastIndexOf(EOCD_SIGNATURE);
  if (eocd < 0) throw new Error('not a zip archive');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('bad central directory');
    const method = zip.readUInt16LE(offset + 10);
    const compressed_size = zip.readUInt32LE(offset + 20);
    const name_length = zip.readUInt16LE(offset + 28);
    const extra_length = zip.readUInt16LE(offset + 30);
    const comment_length = zip.readUInt16LE(offset + 32);
    const local_offset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + name_length).toString('utf-8');
    const data_start =
      local_offset + 30 + zip.readUInt16LE(local_offset + 26) + zip.readUInt16LE(local_offset + 28);
    const data = zip.subarray(data_start, data_start + compressed_size);
    entries.set(name, method === DEFLATE ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + name_length + extra_length + comment_length;
  }
  return entries;
}
