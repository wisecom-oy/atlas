# Storage Request Events

An SDK host can measure every S3 request Atlas sends: how long it took, where the time went, how often the backend throttled, and how large the objects were. This works against any S3-compatible backend, because the numbers come from the Atlas process rather than from provider metrics.

```typescript
import { metrics } from '@opentelemetry/api';
import { createAtlasInstance, type StorageRequestEvent } from '@wisecom/atlas-sdk';

const meter = metrics.getMeter('backup-host');
const latency = meter.createHistogram('atlas.storage.network', {
  unit: 'ms',
  advice: { explicitBucketBoundaries: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] },
});
const queueing = meter.createHistogram('atlas.storage.socket_wait', { unit: 'ms' });
const backoff = meter.createCounter('atlas.storage.retry_delay', { unit: 'ms' });
const payload = meter.createHistogram('atlas.storage.payload', {
  unit: 'By',
  advice: {
    explicitBucketBoundaries: [1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216],
  },
});

function record(event: StorageRequestEvent): void {
  const attributes = {
    command: event.command,
    keyClass: event.keyClass,
    workload: event.workload,
    target: event.target,
    outcome: event.errorType ?? 'ok',
  };
  if (event.networkMs !== undefined) latency.record(event.networkMs, attributes);
  if (event.socketWaitMs !== undefined) queueing.record(event.socketWaitMs, attributes);
  if (event.retryDelayMs > 0) backoff.add(event.retryDelayMs, attributes);
  if (event.bytes !== undefined) payload.record(event.bytes, attributes);
}

const atlas = createAtlasInstance({
  /* ...credentials... */
  onStorageRequest: record,
});
```

Atlas has no OpenTelemetry dependency. `@opentelemetry/api` belongs to the host, which registers its own meter provider and exporter. A host that stores the events in a database or feeds another metrics system writes a different `record` function; the event is a plain object.

The same option on `createStorageTarget` reports requests sent to a replication target. Those events carry the target's `targetId` in `target`; the instance's own requests carry `primary`.

```typescript
const offsite = createStorageTarget({
  targetId: 'offsite-dr',
  /* ...target credentials... */
  onStorageRequest: record,
});
```

Without `onStorageRequest` nothing is installed and the storage path is unchanged. The CLI never installs it.

## Event fields

One event is reported per logical S3 request, after it settles, whether it succeeded or failed.

| Field              | Type       | Description                                                                                                                    |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `command`          | `string`   | S3 operation: `PutObject`, `UploadPart`, `GetObject`, `HeadObject`, `ListObjectsV2`, and so on                                 |
| `operation`        | `string?`  | SDK method in progress, such as `backup` or `replicateSnapshot`. Absent outside an SDK method                                  |
| `workload`         | `string`   | `outlook`, `onedrive`, `sharepoint`, `shared` (keys under `_meta/` or unknown root keys) or `bucket`                           |
| `keyClass`         | `string`   | `data`, `attachments`, `manifests`, `index`, `staging`, `_meta` or `other`                                                     |
| `target`           | `string`   | `primary`, or the replication target's `targetId`                                                                              |
| `startTime`        | `number`   | When the request started, epoch milliseconds                                                                                   |
| `durationMs`       | `number`   | The whole request, including SDK retries and the sleeps between them                                                           |
| `attempts`         | `number`   | Attempts the SDK made, including the first. The SDK default allows 3                                                           |
| `retryDelayMs`     | `number`   | Time slept between attempts                                                                                                    |
| `socketWaitMs`     | `number?`  | Time waiting for a free connection in the SDK pool, summed over attempts                                                       |
| `networkMs`        | `number?`  | Time from obtaining a connection to response headers, summed over attempts                                                     |
| `connectionReused` | `boolean?` | Whether the final attempt used a kept-alive connection                                                                         |
| `bytes`            | `number?`  | Request body length for uploads, copied range length for part copies, response `ContentLength` for reads                       |
| `statusCode`       | `number?`  | HTTP status of the final attempt                                                                                               |
| `errorType`        | `string?`  | Error name on failure: the S3 error code (`SlowDown`, `NoSuchKey`, `PreconditionFailed`) or a transport error (`TimeoutError`) |

Durations are fractional milliseconds. `workload` and `keyClass` come from an allowlist applied to the first segments of the object key or listing prefix, following the [storage layout](/operations/storage-layout); bucket-level commands such as `HeadBucket` report `bucket`.

`socketWaitMs`, `networkMs` and `connectionReused` need Node.js 22.12 or later (or 23.2 and later), where Node publishes the `http.client.request.created` diagnostics channel the split depends on. On older releases these three fields are absent rather than zero.

## Where the time went

```
durationMs ≈ socketWaitMs + networkMs + retryDelayMs + client overhead
```

Each part points at a different cause:

| Large component           | Meaning                                                                                                                                                            | Where to look                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `socketWaitMs`            | Atlas had more requests in flight than the SDK connection pool allows (50 sockets per instance), so requests queued inside the process before reaching the backend | Concurrency in the host: how many operations run on one instance at once                             |
| `networkMs`               | Connection setup when the connection is new, the request body upload, and backend processing until response headers                                                | The backend and the network path to it                                                               |
| `retryDelayMs`            | The backend refused or failed the first attempt (`SlowDown`, `503`, `500`, timeouts) and the SDK backed off before retrying                                        | Backend throttling limits and health; `errorType` on failed requests names the code                  |
| `connectionReused: false` | `networkMs` includes TCP setup, and TLS on HTTPS                                                                                                                   | Frequent `false` on a busy instance means connections are not kept alive, or instances are recreated |

Client overhead is serialisation, signing and event loop scheduling. It is usually small; when it is not, see [event loop delay](#event-loop-delay).

The `socketWaitMs` and `networkMs` split is measured, not inferred. Against a backend with a fixed 100 ms response time and a pool saturated with six concurrent requests over two sockets, whole-attempt time grew from 108 ms to 321 ms while `networkMs` stayed between 103 and 107 ms.

## Latency and throughput

`networkMs` on a large upload includes transferring the body, so it measures throughput, not latency. Read the two from different requests:

- **Latency**: small requests. `HeadObject`, `ListObjectsV2`, manifest reads (`keyClass: 'manifests'`) and small writes. Their `networkMs` is close to the backend's time to first byte.
- **Throughput**: large uploads. `bytes / networkMs` on `PutObject` and `UploadPart` events with large `bytes`, typically `keyClass: 'data'`.

`GetObject` events end at response headers. Their `networkMs` is time to first byte; reading the body happens afterwards in the caller and is not part of the event. A restore that streams a large file to Microsoft Graph spends that time inside the restore, not in the storage event.

Multipart uploads report one event per `UploadPart`, not one for the whole object. `bytes` is the size Atlas sent or received, which is the encrypted size the backend stores and bills, not the logical size of the backed-up item.

## Attributing events

An instance belongs to one tenant, so a host that creates one instance per tenant attributes events to the tenant by closing over it:

```typescript
function create_tenant_instance(tenant: TenantRow): AtlasInstance {
  return createAtlasInstance({
    ...tenant.credentials,
    onStorageRequest: (event) => record({ ...event, tenant: tenant.id }),
  });
}
```

The callback runs synchronously in the async context of the code that issued the request. A host that runs jobs inside an `AsyncLocalStorage` reads its own job identity there:

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';

const current_job = new AsyncLocalStorage<string>();

const atlas = createAtlasInstance({
  /* ...credentials... */
  onStorageRequest: (event) => job_metrics.get(current_job.getStore() ?? 'none')?.add(event),
});

await current_job.run(job.id, () => atlas.outlook.backup(job.mailbox));
```

`operation` names the SDK method, so one instance running a backup and a status check at the same time is still separable.

## Event loop delay

Timings are taken on the Node.js event loop. Atlas hashes and encrypts on the main thread, and a host's own work runs there too. When the loop is blocked, every timer callback is late and every duration grows, including `networkMs`. Watch the loop next to the events:

```typescript
import { monitorEventLoopDelay } from 'node:perf_hooks';

const loop_delay = monitorEventLoopDelay({ resolution: 20 });
loop_delay.enable();

setInterval(() => {
  const p99_ms = loop_delay.percentile(99) / 1e6;
  loop_lag.record(p99_ms);
  loop_delay.reset();
}, 10_000);
```

If the p99 loop delay is in the same range as the latencies being investigated, the storage timings over that window describe the host, not the backend.

## Keeping the callback cheap

The callback runs on the storage path for every request, which is thousands per backup. Record and return: increment counters, add to histograms or push onto an in-memory buffer that is flushed elsewhere. Do not await I/O in it. A callback that throws, or returns a promise that rejects, is ignored and never changes the outcome of the request; Atlas does not wait for a returned promise.

## What an event never contains

Events carry no object key, bucket name, endpoint hostname, credentials, tenant ID, mailbox, owner or site ID. Object keys contain Entra object IDs and bucket names contain the tenant ID, so the allowlisted `workload` and `keyClass` are the only parts of the key that reach the event. See [Security](/security#storage-request-events).
