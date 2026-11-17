---
description: Record the duration, queue wait, retries, payload size, and outcome of every S3 request Atlas sends, on any S3-compatible backend.
---

# Storage request events

An SDK host can receive one event for every S3 request Atlas sends: how long it took, how long it waited for a connection, how often the backend made it retry, how many bytes moved, and how it ended. The numbers are measured inside the Atlas process, so they work with any S3-compatible backend and need no provider metrics.

```ts
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

Atlas has no OpenTelemetry dependency. Your application owns `@opentelemetry/api` and registers its own meter provider and exporter. An event is a plain object, so a host that writes to a database or another metrics system passes a different function.

Without `onStorageRequest`, Atlas installs no measurement and the storage path is unchanged. The CLI never installs it. A value that is not a function throws `ConfigError` when the instance is created.

::: warning Keep the callback cheap
The callback runs on the storage path for every request, which can be thousands per backup. Record and return: increment counters, add to histograms, or push onto an in-memory buffer that another task flushes. Do not await I/O inside it. Atlas ignores a thrown error or a rejected promise and does not wait for the promise, so a failing observer never changes the outcome of a request.
:::

## Event fields

Atlas reports one event per logical S3 request, after the request settles, whether it succeeded or failed.

| Field              | Type       | Description                                                                                                                                       |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`          | `string`   | S3 operation: `PutObject`, `UploadPart`, `GetObject`, `HeadObject`, `ListObjectsV2`, and so on                                                    |
| `operation`        | `string?`  | SDK method in progress, such as `backup` or `restore`. Absent outside an SDK method                                                               |
| `workload`         | `string`   | `outlook`, `onedrive`, `sharepoint`, `teams`, `contacts`, `calendar`, `shared` (paths under `_meta/` or unknown root paths), or `bucket`           |
| `keyClass`         | `string`   | `data`, `attachments`, `manifests`, `index`, `staging`, `_meta`, or `other`                                                                       |
| `startTime`        | `number`   | When the request started, in epoch milliseconds                                                                                                   |
| `durationMs`       | `number`   | The whole logical request, including SDK retries and the waits between them                                                                       |
| `attempts`         | `number`   | Attempts the AWS SDK made, including the first. Its default is 3                                                                                  |
| `retryDelayMs`     | `number`   | Time spent waiting between attempts                                                                                                               |
| `socketWaitMs`     | `number?`  | Time waiting for a free connection in the SDK pool, summed over attempts                                                                          |
| `networkMs`        | `number?`  | Time from obtaining a connection to the response headers, summed over attempts                                                                    |
| `connectionReused` | `boolean?` | Whether the final attempt used a kept-alive connection                                                                                            |
| `bytes`            | `number?`  | Payload bytes: request body for uploads, copied range for part copies, response `ContentLength` for `GetObject`. Absent for bodiless requests such as `HeadObject` |
| `statusCode`       | `number?`  | HTTP status of the final attempt                                                                                                                  |
| `errorType`        | `string?`  | Error name on failure: an S3 error code (`SlowDown`, `NoSuchKey`, `PreconditionFailed`) or a transport error (`TimeoutError`)                     |

- Durations are fractional milliseconds.
- `workload` and `keyClass` come from an allowlist applied to the first segments of the object path or listing prefix, following the [storage layout](/operations/storage-layout). Bucket-level commands such as `HeadBucket` report `bucket`.
- `socketWaitMs`, `networkMs`, and `connectionReused` need Node.js 22.12 or later, or 23.2 and later: the releases that publish the `http.client.request.created` diagnostics channel the split depends on. On older releases these three fields are absent, not zero.

## Where the time went

```
durationMs ≈ socketWaitMs + networkMs + retryDelayMs + client overhead
```

Each part points at a different cause:

| Large component           | Meaning                                                                                                                                   | Where to look                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `socketWaitMs`            | More requests were in flight than the connection pool allows (50 sockets per instance, the AWS SDK default), so requests queued in the process | Concurrency in your application: how many operations run on one instance at once                   |
| `networkMs`               | Connection setup on a new connection, the request body upload, and backend processing up to the response headers                          | The backend and the network path to it                                                              |
| `retryDelayMs`            | The backend refused or failed an attempt (`SlowDown`, `503`, `500`, timeouts) and the SDK backed off before retrying                       | Backend throttling limits and health. `errorType` on failed requests names the code                 |
| `connectionReused: false` | `networkMs` includes TCP setup, and TLS on HTTPS                                                                                          | Frequent `false` on a busy instance means connections are not kept alive, or instances are recreated |

Client overhead is serialization, request signing, and event loop scheduling. It is usually small. When it is not, check the [event loop delay](#event-loop-delay).

See [Retries and fail-safes](/operations/reliability#storage) for the retry strategy behind `attempts` and `retryDelayMs`.

## Latency and throughput

On a large upload, `networkMs` includes sending the body, so it measures throughput rather than latency. Read the two from different requests:

- **Latency:** small requests such as `HeadObject`, `ListObjectsV2`, manifest reads (`keyClass: 'manifests'`), and small writes. Their `networkMs` is close to the backend's time to first byte.
- **Throughput:** large uploads. Divide `bytes` by `networkMs` on `PutObject` and `UploadPart` events with a large `bytes`, typically `keyClass: 'data'`.

What else to know when reading the numbers:

- `GetObject` events end at the response headers, so their `networkMs` is time to first byte. Reading the body happens afterwards in the caller and is not part of the event. A restore that streams a large file to Microsoft 365 spends that time inside the restore, not in the storage event.
- Multipart uploads report one event per `UploadPart`, not one for the whole object.
- `bytes` is the size Atlas sent or received: the encrypted size the backend stores and bills, not the logical size of the backed-up item.

## Attributing events

An instance belongs to one tenant. A host that creates one instance per tenant can attribute events by closing over the tenant:

```ts
function create_tenant_instance(tenant: TenantRow): AtlasInstance {
  return createAtlasInstance({
    ...tenant.credentials,
    // Forward each event to your metrics sink; do not buffer them in memory.
    onStorageRequest: (event) => record({ ...event, tenant: tenant.id }),
  });
}
```

The callback runs synchronously, in the async context of the code that issued the request. A host that runs jobs inside `AsyncLocalStorage` can read its own job identity there:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

const current_job = new AsyncLocalStorage<string>();

const atlas = createAtlasInstance({
  /* ...credentials... */
  onStorageRequest: (event) => job_metrics.get(current_job.getStore() ?? 'none')?.add(event),
});

await current_job.run(job.id, () => atlas.outlook.backup(job.mailbox));
```

`operation` names the SDK method, so a backup and a status check running at the same time on one instance stay separable. A [cross-tenant restore](/reference/sdk#cross-tenant-restore) reads through its own S3 client but still reports every request to the instance's callback.

## Event loop delay

Atlas hashes and encrypts on the Node.js main thread, and your application's own work runs there too. When the loop is blocked, every timer fires late and every duration grows, `networkMs` included. Watch the loop next to the events:

```ts
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

Events carry no object path, bucket name, endpoint hostname, credentials, tenant ID, mailbox, owner, or site ID. Object paths contain Entra object IDs and bucket names contain the tenant ID, so the allowlisted `workload` and `keyClass` are the only parts of a path that reach the event. Byte counts are ciphertext sizes, so over many requests they still reveal the size distribution of stored objects; treat exported metrics accordingly. See [Security](/security#storage-request-events).
