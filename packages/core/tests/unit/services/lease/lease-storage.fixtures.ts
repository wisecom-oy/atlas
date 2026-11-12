import type { ObjectStorage } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';

/** Switches a test flips to make the bucket misbehave the way a real backend can. */
export interface StorageFaults {
  /** Every request rejects with HTTP 503, as during an outage. */
  unavailable: boolean;
  /** Writes ignore If-Match and If-None-Match, as some S3-compatible backends do. */
  ignore_conditions: boolean;
  /** Puts reject with 403 AccessDenied, as read-only credentials do. */
  deny_writes: boolean;
}

/** An in-memory bucket honouring conditional writes, plus switches to inject backend faults. */
export interface LeaseTestBucket {
  readonly storage: ObjectStorage;
  readonly faults: StorageFaults;
  readonly keys: () => string[];
  /** The stored object parsed as JSON, or undefined when absent. */
  readonly json: (key: string) => Record<string, unknown> | undefined;
  /** Writes an object directly, bypassing faults, as another process would. */
  readonly write: (key: string, body: unknown) => Promise<void>;
}

function unavailable_error(): Error {
  return Object.assign(new Error('Service Unavailable'), {
    name: 'ServiceUnavailable',
    $metadata: { httpStatusCode: 503 },
  });
}

function access_denied_error(): Error {
  return Object.assign(new Error('Access Denied'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });
}

/** Builds the bucket. Only the members the lease code calls are wrapped. */
export function lease_test_bucket(): LeaseTestBucket {
  const harness = in_memory_tenant_context();
  const inner = harness.ctx.storage;
  const faults: StorageFaults = {
    unavailable: false,
    ignore_conditions: false,
    deny_writes: false,
  };
  const guard = (): void => {
    if (faults.unavailable) throw unavailable_error();
  };
  const storage = {
    async put(
      key: string,
      data: Buffer,
      metadata?: Record<string, string>,
      policy?: undefined,
      if_match?: string,
      if_none_match?: boolean,
    ): Promise<void> {
      guard();
      if (faults.deny_writes) throw access_denied_error();
      if (faults.ignore_conditions) return inner.put(key, data);
      return inner.put(key, data, metadata, policy, if_match, if_none_match);
    },
    async get_with_etag(key: string) {
      guard();
      return inner.get_with_etag(key);
    },
    async get(key: string) {
      guard();
      return inner.get(key);
    },
    async delete(key: string) {
      guard();
      return inner.delete(key);
    },
    async list(prefix: string, limit?: number) {
      guard();
      return inner.list(prefix, limit);
    },
    async exists(key: string) {
      guard();
      return inner.exists(key);
    },
  } as unknown as ObjectStorage;
  return {
    storage,
    faults,
    keys: harness.keys,
    json: (key) => {
      const raw = harness.raw(key);
      return raw === undefined ? undefined : (JSON.parse(raw.toString('utf-8')) as never);
    },
    write: (key, body) => inner.put(key, Buffer.from(JSON.stringify(body))),
  };
}

/** A lease body another process holds, valid until `expires_at`. */
export function foreign_lease(expires_at: Date, operation = 'backup'): Record<string, unknown> {
  return {
    format: 1,
    token: 'someone-else',
    operation,
    host: 'other-host',
    pid: 4242,
    started_at: new Date(expires_at.getTime() - 60_000).toISOString(),
    renewed_at: new Date(expires_at.getTime() - 60_000).toISOString(),
    expires_at: expires_at.toISOString(),
  };
}
