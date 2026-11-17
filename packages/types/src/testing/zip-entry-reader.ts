import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/**
 * Reads every entry of a complete zip archive into a map of entry path to content.
 *
 * Walks the central directory, so an archive that was cut off before it was finalized throws
 * instead of yielding a partial entry. Handles the stored and deflated methods only, which is all
 * the save archive writes.
 */
export function read_zip_entries(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.lastIndexOf(uint32(END_OF_CENTRAL_DIRECTORY));
  if (eocd < 0) throw new Error('Not a complete zip archive: no end of central directory');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();

  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error(`Corrupt central directory at offset ${offset}`);
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressed_size = zip.readUInt32LE(offset + 20);
    const name_length = zip.readUInt16LE(offset + 28);
    const extra_length = zip.readUInt16LE(offset + 30);
    const comment_length = zip.readUInt16LE(offset + 32);
    const local_offset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + name_length);
    const data_start =
      local_offset + 30 + zip.readUInt16LE(local_offset + 26) + zip.readUInt16LE(local_offset + 28);
    entries.set(
      name,
      inflate_entry(zip.subarray(data_start, data_start + compressed_size), method),
    );
    offset += 46 + name_length + extra_length + comment_length;
  }
  return entries;
}

/** Decodes one entry's data for its compression method. */
function inflate_entry(data: Buffer, method: number): Buffer {
  if (method === METHOD_STORED) return Buffer.from(data);
  if (method === METHOD_DEFLATED) return inflateRawSync(data);
  throw new Error(`Unsupported zip compression method ${method}`);
}

/** Encodes a little-endian 32-bit signature for searching. */
function uint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}
