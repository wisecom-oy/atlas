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
  /**
   * Rejects any `PutObject` that carries `If-None-Match` or `If-Match` with `501 NotImplemented`,
   * as a backend without conditional `PUT` on versioned buckets may (issue #974).
   */
  readonly rejects_condition_headers?: boolean;
  /** Answers `HeadObject` without an `ETag`, as some backends do; GET and PUT still carry one. */
  readonly head_omits_etag?: boolean;
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

/** A backend that answers every conditional `PUT` with `501 NotImplemented` (issue #974). */
export const REJECTING: ConditionalBehaviour = {
  ...IGNORING,
  rejects_condition_headers: true,
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

export function etag_of(body: Buffer): string {
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

function carries_condition(input: CommandLike['input']): boolean {
  return input.IfNoneMatch !== undefined || input.IfMatch !== undefined;
}

/** An unversioned in-memory bucket behind a mock `S3Client.send`, with the given condition handling. */
export function fake_conditional_s3(behaviour: ConditionalBehaviour) {
  const objects = new Map<string, Buffer>();
  /** Runs once after the next stored `PutObject`, as another process writing in between would. */
  let after_next_put: ((key: string) => void) | undefined;
  const send = vi.fn(async (cmd: CommandLike) => {
    const key = cmd.input.Key ?? '';
    switch (cmd.constructor.name) {
      case 'HeadBucketCommand':
        return {};
      case 'HeadObjectCommand': {
        const data = objects.get(key);
        if (!data) throw named_error('NotFound', 404);
        return behaviour.head_omits_etag ? {} : { ETag: etag_of(data) };
      }
      case 'PutObjectCommand': {
        if (behaviour.rejects_condition_headers && carries_condition(cmd.input)) {
          throw named_error('NotImplemented', 501);
        }
        if (refuses(behaviour, cmd.input, objects.get(key))) {
          throw named_error('PreconditionFailed', 412);
        }
        const body = Buffer.from(cmd.input.Body ?? Buffer.alloc(0));
        objects.set(key, body);
        const hook = after_next_put;
        after_next_put = undefined;
        hook?.(key);
        return { ETag: etag_of(body) };
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
  /** How many `PutObject` requests carried `If-None-Match` or `If-Match`. */
  const conditional_puts = (): number =>
    send.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd.constructor.name === 'PutObjectCommand' && carries_condition(cmd.input))
      .length;
  /** Replaces `key` with `body` right after the next put stores, as a second writer would. */
  const overwrite_after_next_put = (body: Buffer): void => {
    after_next_put = (key) => objects.set(key, body);
  };
  return {
    send,
    objects,
    put_keys,
    probes_started,
    conditional_puts,
    overwrite_after_next_put,
  };
}
