import { createHash } from 'node:crypto';
import { vi } from 'vitest';

/** How a fake backend treats the three write conditions the probe sends. */
export interface ConditionalBehaviour {
  /** Refuses `If-None-Match: *` onto an existing key. */
  readonly enforces_create_only: boolean;
  /** Refuses `If-Match` with an ETag the object no longer has. */
  readonly enforces_stale_if_match: boolean;
  /** Refuses `If-Match` even with the current ETag. */
  readonly refuses_current_if_match: boolean;
}

/** MinIO, SeaweedFS, RustFS and Versity, as measured in issue #915. */
export const ENFORCING: ConditionalBehaviour = {
  enforces_create_only: true,
  enforces_stale_if_match: true,
  refuses_current_if_match: false,
};

/** Garage v2.1.0 and Scality CloudServer 9.1.0: every condition is accepted. */
export const IGNORING: ConditionalBehaviour = {
  enforces_create_only: false,
  enforces_stale_if_match: false,
  refuses_current_if_match: false,
};

/** Ceph RGW 18.2.4: create-only accepted, every `If-Match` refused. */
export const CEPH_18: ConditionalBehaviour = {
  enforces_create_only: false,
  enforces_stale_if_match: true,
  refuses_current_if_match: true,
};

interface CommandLike {
  readonly constructor: { readonly name: string };
  readonly input: {
    readonly Key?: string;
    readonly Prefix?: string;
    readonly Body?: Buffer;
    readonly IfMatch?: string;
    readonly IfNoneMatch?: string;
  };
}

function named_error(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

function etag_of(body: Buffer): string {
  return `"${createHash('md5').update(body).digest('hex')}"`;
}

/** Whether the fake refuses this put, by its behaviour and what is stored under the key. */
function refuses(
  behaviour: ConditionalBehaviour,
  input: CommandLike['input'],
  current: Buffer | undefined,
): boolean {
  if (input.IfNoneMatch === '*' && current && behaviour.enforces_create_only) return true;
  if (input.IfMatch === undefined) return false;
  if (behaviour.refuses_current_if_match) return true;
  return (
    behaviour.enforces_stale_if_match && current !== undefined && etag_of(current) !== input.IfMatch
  );
}

/** An unversioned in-memory bucket behind a mock `S3Client.send`, with the given condition handling. */
export function fake_conditional_s3(behaviour: ConditionalBehaviour) {
  const objects = new Map<string, Buffer>();
  const send = vi.fn(async (cmd: CommandLike) => {
    const key = cmd.input.Key ?? '';
    switch (cmd.constructor.name) {
      case 'HeadBucketCommand':
        return {};
      case 'HeadObjectCommand':
        if (!objects.has(key)) throw named_error('NotFound', 404);
        return {};
      case 'PutObjectCommand': {
        if (refuses(behaviour, cmd.input, objects.get(key))) {
          throw named_error('PreconditionFailed', 412);
        }
        objects.set(key, Buffer.from(cmd.input.Body ?? Buffer.alloc(0)));
        return {};
      }
      case 'GetObjectCommand': {
        const data = objects.get(key);
        if (!data) throw named_error('NoSuchKey', 404);
        return {
          Body: { transformToByteArray: async () => new Uint8Array(data) },
          ETag: etag_of(data),
        };
      }
      case 'DeleteObjectCommand':
        objects.delete(key);
        return {};
      case 'ListObjectVersionsCommand':
        return { IsTruncated: false };
      default:
        throw new Error(`Unexpected command in fake S3: ${cmd.constructor.name}`);
    }
  });
  /** The keys of every PutObject sent so far, in order. */
  const put_keys = (): string[] =>
    send.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd.constructor.name === 'PutObjectCommand')
      .map((cmd) => cmd.input.Key ?? '');
  /** How many probes have started: each writes one new object under the probe prefix. */
  const probes_started = (): number =>
    new Set(put_keys().filter((key) => key.startsWith('_meta/storage-check/'))).size;
  return { send, objects, put_keys, probes_started };
}
