/**
 * Filesystem implementation of the ObjectStorage port, used in place of S3.
 *
 * Each key segment becomes one directory or file name, percent-encoded so `/` in a key is never
 * read as a separator by accident. Writes go to a temp file and rename into place, so a killed
 * process never leaves a half-written object. Object Lock, versioning, and stale multipart
 * housekeeping are not modelled; the Teams backup path does not use them without an object lock
 * request, and the methods below throw if something reaches them.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';

/** Creates an S3-style error carrying the `name` the Atlas adapters branch on. */
export function storage_error(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

const unsupported = (method) => () => {
  throw new Error(
    `FsObjectStorage does not implement ${method}; the Teams backup path does not call it`,
  );
};

/** Filesystem-backed object storage rooted at one directory. */
export class FsObjectStorage {
  /** @param {string} root directory holding the tenant's objects */
  constructor(root) {
    this.root = root;
  }

  /** @param {string} key */
  file_for(key) {
    return path.join(this.root, ...key.split('/').map((s) => encodeURIComponent(s)));
  }

  /** Writes bytes atomically: temp file, then rename. */
  async write_atomic(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  }

  /** @returns {Promise<Buffer|undefined>} undefined when the object is absent */
  async read_optional(key) {
    try {
      return await fs.readFile(this.file_for(key));
    } catch (err) {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /**
   * @param {string} key
   * @param {Buffer} data
   * @param {Record<string,string>} [_metadata] accepted for port compatibility, not stored
   * @param {unknown} [_object_lock_policy] must be absent; locks are not modelled
   * @param {string} [if_match] etag the stored object must still carry
   * @param {boolean} [if_none_match] fail when the object already exists
   */
  async put(key, data, _metadata, _object_lock_policy, if_match, if_none_match) {
    if (if_none_match) {
      await this.create_exclusive(this.file_for(key), data, key);
      return;
    }
    const current = await this.read_optional(key);
    if (if_match !== undefined && (current === undefined || etag_of(current) !== if_match)) {
      throw storage_error('PreconditionFailed', `etag mismatch: ${key}`);
    }
    await this.write_atomic(this.file_for(key), data);
  }

  /**
   * Creates the object only if no object exists. The bytes are complete in a temp file before a
   * hard link publishes them, and `link` fails with EEXIST for the one writer that loses the race.
   */
  async create_exclusive(file, data, key) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, data);
    try {
      await fs.link(tmp, file);
    } catch (err) {
      if (err.code === 'EEXIST') throw storage_error('PreconditionFailed', `object exists: ${key}`);
      throw err;
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  /** @param {string} key */
  async get(key) {
    const data = await this.read_optional(key);
    if (data === undefined) throw storage_error('NoSuchKey', `no such key: ${key}`);
    return data;
  }

  /** @param {string} key @returns {Promise<{data: Buffer, etag: string}>} */
  async get_with_etag(key) {
    const data = await this.get(key);
    return { data, etag: etag_of(data) };
  }

  /** @param {string} key */
  async get_stream(key) {
    await this.get(key);
    return createReadStream(this.file_for(key));
  }

  /** @param {string} key */
  async delete(key) {
    await fs.rm(this.file_for(key), { force: true });
  }

  /** @param {string} key */
  async exists(key) {
    return (await this.read_optional(key)) !== undefined;
  }

  /**
   * Lists keys starting with `prefix`, sorted like S3.
   * @param {string} prefix
   * @param {number} [limit]
   */
  async list(prefix, limit) {
    const slash = prefix.lastIndexOf('/');
    const dir_keys = slash === -1 ? '' : prefix.slice(0, slash);
    const base = path.join(
      this.root,
      ...(dir_keys ? dir_keys.split('/').map((s) => encodeURIComponent(s)) : []),
    );
    const keys = (await walk(base, dir_keys ? `${dir_keys}/` : '')).filter((k) =>
      k.startsWith(prefix),
    );
    keys.sort();
    return limit === undefined ? keys : keys.slice(0, limit);
  }

  /**
   * Copies an object. Source must exist; the destination is replaced.
   * @param {string} source_key
   * @param {string} dest_key
   */
  async copy(source_key, dest_key) {
    await this.write_atomic(this.file_for(dest_key), await this.get(source_key));
  }

  /**
   * Multipart upload held in memory until `complete`, which writes the object in one step.
   * @param {string} key
   */
  async begin_multipart_upload(key) {
    const parts = new Map();
    const storage = this;
    return {
      async upload_part(part_number, data) {
        const copy = Buffer.from(data);
        parts.set(part_number, copy);
        return etag_of(copy);
      },
      async complete(ordered) {
        const buffers = ordered
          .map((p) => ({ n: p.PartNumber, etag: p.ETag }))
          .sort((a, b) => a.n - b.n)
          .map(({ n, etag }) => {
            const part = parts.get(n);
            if (!part || etag_of(part) !== etag) {
              throw storage_error('InvalidPart', `part ${n} missing or etag mismatch: ${key}`);
            }
            return part;
          });
        await storage.write_atomic(storage.file_for(key), Buffer.concat(buffers));
        parts.clear();
      },
      async abort() {
        parts.clear();
      },
    };
  }

  list_versions = unsupported('list_versions');
  delete_version = unsupported('delete_version');
  probe_immutability = unsupported('probe_immutability');
  validate_object_lock_policy = unsupported('validate_object_lock_policy');
  list_stale = unsupported('list_stale');
  abort_incomplete_uploads = unsupported('abort_incomplete_uploads');
}

/** Hex SHA-256 of the bytes; stable across runs, so conditional writes compare cleanly. */
export function etag_of(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Collects every file under `dir` as an object key, skipping in-flight temp files.
 * @param {string} dir
 * @param {string} key_prefix
 * @returns {Promise<string[]>}
 */
async function walk(dir, key_prefix) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    if (entry.name.endsWith('.tmp')) continue;
    const name = decodeURIComponent(entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(path.join(dir, entry.name), `${key_prefix}${name}/`)));
    } else {
      out.push(`${key_prefix}${name}`);
    }
  }
  return out;
}
