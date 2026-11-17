# 18. Observability and Operability

A production system must explain what it is doing.

## 18.1 Emit useful telemetry

The three common telemetry signals are:

- logs - discrete events with contextual fields;
- metrics - aggregated numeric behavior over time;
- traces - causally connected operations across components.

Instrumentation should answer real operational questions, not create noise.

## 18.2 Monitor user-visible health

For online services, a useful starting set is the SRE "four golden signals":

- **Latency** - how long requests/work take, including failed vs successful latency when useful.

- **Traffic** - demand on the service.

- **Errors** - failed or incorrect operations.

- **Saturation** - how close a constrained resource is to its limit.

Add domain metrics where they matter: jobs stuck, payment failures, replication lag, backup age, queue depth, restore integrity failures, etc.

## 18.3 Use structured logs

Prefer fields:

```json
{
  "event": "order.payment_failed",
  "orderId": "ord_123",
  "provider": "stripe",
  "errorCode": "TIMEOUT",
  "durationMs": 2140,
  "requestId": "req_456"
}
```

over concatenated prose that is difficult to query.

## 18.4 Log outcomes at the correct boundary

Useful events include:

- important state transition completed/failed;
- dependency call failed after retry policy;
- authorization denied for a sensitive action;
- integrity check failed;
- background job exhausted attempts;
- data migration skipped an invalid record.

Do not log every function entry/exit by default.

## 18.5 Never log secrets

Do not write plaintext:

- passwords;
- access/refresh tokens;
- session IDs when they function as credentials;
- API keys;
- encryption keys;
- database connection strings containing credentials;
- sensitive personal data unless explicitly required, minimized, and protected.

Sanitize user-controlled log fields to prevent log injection and keep log access controlled.

## 18.6 Correlate work

Use request IDs, trace IDs, job IDs, order IDs, or another safe domain identifier to connect events across layers.

Do not generate a new unrelated correlation ID at every function.

## 18.7 Health checks should test what they claim

Separate concepts such as:

- process is alive;
- process is ready to receive traffic;
- required dependencies are reachable;
- background subsystem is caught up.

A liveness endpoint should not restart a healthy process merely because a remote dependency is temporarily unavailable unless that behavior is intentional.

## 18.8 Telemetry itself must fail safely

A logging/metrics backend outage should normally not crash the business operation. Instrumentation queues must be bounded. Avoid recursion where logging a logging failure creates more logging failures.
