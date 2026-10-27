---
description: Subscribe to Atlas S3 request events to record duration, queue wait, backend retries, payload size, and outcome for any S3-compatible backend.
---

# Storage request events

Atlas can report every S3 request it sends: duration, time spent queued for a connection, backend retries, payload size, and the outcome. The numbers come from the Atlas process, so they work with any S3-compatible backend and do not depend on provider metrics.

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

Atlas has no OpenTelemetry dependency. The host owns `@opentelemetry/api` and registers its own meter provider and exporter. A host that writes events to a database or another metrics system passes a different function; an event is a plain object.

The same option on `createStorageTarget` reports requests sent to a replication target. Those events carry the target's `targetId` in `target`. The instance's own requests carry `primary`.

```typescript
const offsite = createStorageTarget({
  targetId: 'offsite-dr',
  /* ...target credentials... */
  onStorageRequest: record,
});
```

Without `onStorageRequest`, Atlas installs no measurement and the storage path is unchanged. The CLI does not install it.

::: warning Keep the callback cheap
The callback runs on the storage path for every request, which can be thousands per backup. Record and return: increment counters, add to histograms, or push onto an in-memory buffer that another task flushes. Do not await I/O inside it. Atlas ignores a thrown error or a rejected promise from the callback, so a failing observer never changes the outcome of a request, and Atlas does not wait for the promise.
:::

## Event fields

Atlas reports one event per logical S3 request, after the request settles, whether it succeeded or failed.

| Field              | Type       | Description                                                                                                                                                                       |
| ------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`          | `string`   | S3 operation: `PutObject`, `UploadPart`, `GetObject`, `HeadObject`, `ListObjectsV2`, and so on                                                                                    |
| `operation`        | `string?`  | SDK method in progress, such as `backup` or `replicateSnapshot`. Absent outside an SDK method                                                                                     |
| `workload`         | `string`   | `outlook`, `onedrive`, `sharepoint`, `shared` (keys under `_meta/` or unknown root keys), or `bucket`                                                                             |
| `keyClass`         | `string`   | `data`, `attachments`, `manifests`, `index`, `staging`, `_meta`, or `other`                                                                                                       |
| `target`           | `string`   | `primary`, or the replication target's `targetId`                                                                                                                                 |
| `startTime`        | `number`   | When the request started, in epoch milliseconds                                                                                                                                   |
| `durationMs`       | `number`   | The whole logical request, including SDK retries and the sleeps between them                                                                                                      |
| `attempts`         | `number`   | Attempts the SDK made, including the first. The AWS SDK default is 3                                                                                                              |
| `retryDelayMs`     | `number`   | Time slept between attempts                                                                                                                                                       |
| `socketWaitMs`     | `number?`  | Time waiting for a free connection in the SDK pool, summed over attempts                                                                                                          |
| `networkMs`        | `number?`  | Time from obtaining a connection to response headers, summed over attempts                                                                                                        |
| `connectionReused` | `boolean?` | Whether the final attempt used a kept-alive connection                                                                                                                            |
| `bytes`            | `number?`  | Payload bytes: request body length for uploads, copied range length for part copies, and response `ContentLength` for `GetObject`. Absent for bodiless requests such as `HeadObject` |
| `statusCode`       | `number?`  | HTTP status of the final attempt                                                                                                                                                  |
| `errorType`        | `string?`  | Error name on failure: an S3 error code (`SlowDown`, `NoSuchKey`, `PreconditionFailed`) or a transport error (`TimeoutError`)                                                     |

Durations are fractional milliseconds. `workload` and `keyClass` come from an allowlist applied to the leading segments of the object key or listing prefix, following the [storage layout](/operations/storage-layout). Bucket-level commands such as `HeadBucket` report `bucket`.

`socketWaitMs`, `networkMs`, and `connectionReused` need Node.js 22.12 or later (or 23.2 and later), the releases that publish the `http.client.request.created` diagnostics channel the split depends on. On older releases these three fields are absent, not zero.

## Where the time went

```
durationMs ≈ socketWaitMs + networkMs + retryDelayMs + client overhead
```

Each part points at a different cause:

| Large component           | Meaning                                                                                                                                                                  | Where to look                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `socketWaitMs`            | More requests were in flight than the SDK connection pool allows (50 sockets per instance, the AWS SDK default), so requests queued in the process before reaching the backend | Concurrency in the host: how many operations run on one instance at once                   |
| `networkMs`               | Connection setup on a new connection, the request body upload, and backend processing up to response headers                                                            | The backend and the network path to it                                                     |
| `retryDelayMs`            | The backend refused or failed an attempt (`SlowDown`, `503`, `500`, timeouts) and the SDK backed off before retrying                                                     | Backend throttling limits and health. `errorType` on failed requests names the code        |
| `connectionReused: false` | `networkMs` includes TCP setup, and TLS on HTTPS                                                                                                                         | Frequent `false` on a busy instance means connections are not kept alive, or instances are recreated |

Client overhead is serialization, request signing, and event loop scheduling. It is usually small. When it is not, check [event loop delay](#event-loop-delay).

## Latency and throughput

`networkMs` on a large upload includes transferring the body, so for that request it measures throughput rather than latency. Read the two from different requests:

- **Latency:** small requests such as `HeadObject`, `ListObjectsV2`, manifest reads (`keyClass: 'manifests'`), and small writes. Their `networkMs` is close to the backend's time to first byte.
- **Throughput:** large uploads. Divide `bytes` by `networkMs` on `PutObject` and `UploadPart` events with a large `bytes`, typically `keyClass: 'data'`.

`GetObject` events end at response headers. Their `networkMs` is time to first byte. Reading the body happens afterwards in the caller and is not part of the event. A restore that streams a large file to Microsoft Graph spends that time inside the restore, not in the storage event.

Multipart uploads report one event per `UploadPart`, not one event for the whole object. `bytes` is the size Atlas sent or received. That is the encrypted size the backend stores and bills, not the logical size of the backed-up item.

## Attributing events

An instance belongs to one tenant. A host that creates one instance per tenant can attribute events by closing over the tenant:

```typescript
const tenant_events: Array<StorageRequestEvent & { tenant: string }> = [];

function create_tenant_instance(tenant: TenantRow): AtlasInstance {
  return createAtlasInstance({
    ...tenant.credentials,
    onStorageRequest: (event) => tenant_events.push({ ...event, tenant: tenant.id }),
  });
}
```

The callback runs synchronously, in the async context of the code that issued the request. A host that runs jobs inside `AsyncLocalStorage` can read its own job identity there:

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';

const current_job = new AsyncLocalStorage<string>();

const atlas = createAtlasInstance({
  /* ...credentials... */
  onStorageRequest: (event) => job_metrics.get(current_job.getStore() ?? 'none')?.add(event),
});

await current_job.run(job.id, () => atlas.outlook.backup(job.mailbox));
```

`operation` names the SDK method, so a backup and a status check running at the same time on one instance remain separable.

## Event loop delay

Atlas hashes and encrypts on the Node.js main thread, and a host's own work runs there too. When the loop is blocked, every timer callback is late and every duration grows, including `networkMs`. Watch the loop next to the events:

```typescript
import { monitorEventLoopDelay } from 'node:perf_hooks';

const loop_lag = meter.createHistogram('atlas.event_loop.delay_p99', { unit: 'ms' });

const loop_delay = monitorEventLoopDelay({ resolution: 20 });
loop_delay.enable();

setInterval(() => {
  const p99_ms = loop_delay.percentile(99) / 1e6;
  loop_lag.record(p99_ms);
  loop_delay.reset();
}, 10_000);
```

If the p99 loop delay is in the same range as the latencies you are investigating, the storage timings for that window describe the host, not the backend.

## What an event never contains

Events carry no object key, bucket name, endpoint hostname, credentials, tenant ID, mailbox, owner, or site ID. Object keys contain Entra object IDs and bucket names contain the tenant ID, so the allowlisted `workload` and `keyClass` are the only parts of a key that reach the event. See [Security](/security#storage-request-events).
