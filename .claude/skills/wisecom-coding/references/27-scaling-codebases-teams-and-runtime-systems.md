# 27. Scaling Codebases, Teams, and Runtime Systems

"Scale" has several meanings, and confusing them creates unnecessary architecture.

A system may need to scale in:

- request throughput;
- concurrent users or jobs;
- data volume;
- geographic availability;
- reliability requirements;
- number of features/domains;
- number of engineers/teams;
- deployment frequency;
- integration count;
- operational complexity.

These problems do not all have the same solution. Microservices do not automatically fix a large codebase. More servers do not fix a serialized database bottleneck. A queue does not fix an unbounded producer. A distributed cache does not fix a bad data model.

The core rule is:

Scale the dimension that is actually constrained, and preserve the simplest architecture that meets the requirement.

## 27.1 Start simple enough to change

A well-structured monolith is often the correct starting point and can scale far beyond the first production requirements.

Do not split a new system into network services merely because the system may become important.

A modular monolith gives you:

- one deployment unit;
- local transactions;
- cheap function calls instead of network calls;
- simpler debugging;
- simpler local development;
- fewer compatibility/versioning problems;
- the ability to establish real domain boundaries before paying distributed-system costs.

A monolith becomes dangerous primarily when it is unmodular: everything imports everything, tables are modified from everywhere, shared utilities contain business policy, and no one knows where a feature belongs.

Therefore design boundaries early, but distribute them only when distribution solves a real problem.

## 27.2 Scale architecture in stages

A useful default progression is:

```
single clear application
    -> modular monolith
    -> replicated/stateless application instances
    -> independently scalable workers/components
    -> selected service extraction where justified
    -> broader distributed architecture only where needed
```

This is not a mandatory maturity model. A hard external constraint can justify starting at a later stage. The point is that every step adds failure modes and operational cost, so each step needs a reason.

## 27.3 Organize modules around business capabilities

Large codebases become easier to change when a module has one coherent domain responsibility and owns its internal details.

Good boundaries often resemble business capabilities:

- Identity
- Catalog
- Ordering
- Billing
- Fulfillment
- Reporting

rather than technical buckets:

- Controllers
- Services
- Helpers
- Models
- Utils

Technical layers can exist inside a capability, but business changes should not require editing unrelated global buckets across the whole repository.

A bounded context SHOULD own its vocabulary and invariants. The same real-world concept may legitimately have different representations in different contexts.

For example, an Account in authentication does not need every property of an Account in billing. Sharing one giant universal entity couples two domains that may evolve independently.

## 27.4 Make ownership explicit before making deployment independent

A component is not autonomous because it lives in another repository or process.

Real autonomy requires clear ownership of:

- behavior;
- data writes;
- public contract;
- deployment lifecycle;
- failure policy;
- observability;
- security boundary;
- compatibility obligations.

If two "services" must deploy together, mutate the same tables directly, call each other synchronously for every request, and share internal models, the architecture is a distributed monolith.

Prefer strong logical/module boundaries first. Extract a network service when independent deployment, scaling, security isolation, failure isolation, technology requirements, or team autonomy materially justify it.

## 27.5 Keep dependencies directional

As a codebase grows, circular dependencies destroy local reasoning.

Define a dependency direction such as:

```
interface / delivery
        -> application orchestration
        -> domain policy

infrastructure adapters -> application-owned ports/contracts
```

or another repository-appropriate structure.

The exact layers are less important than these properties:

- business policy does not depend directly on every infrastructure SDK;
- modules do not reach into each other's private internals;
- shared code does not become a dumping ground;
- circular imports/dependencies are treated as a design smell;
- cross-module behavior goes through a deliberate contract.

## 27.6 Split shared libraries carefully

A shared library can remove duplication, but it can also couple every consumer to one release cadence.

Good shared libraries usually contain stable cross-cutting mechanisms:

- protocol/client foundations;
- observability primitives;
- cryptographic wrappers;
- schema-generated contracts;
- generic retry/timeout utilities;
- small universally agreed value types.

Be cautious about putting changing business policy into a globally shared package. If five domains depend on common-business, every policy change can become a synchronized migration.

Prefer duplication of a tiny context-specific rule over a shared abstraction with the wrong ownership.

## 27.7 Horizontal scaling requires interchangeable instances

Adding more application instances helps only when requests/jobs can be handled by any appropriate instance.

Prefer instances that are stateless with respect to request ownership:

- persist durable state in a shared/partitioned durable store;
- store session state outside one process when session continuity is required;
- do not depend on local disk unless the data is disposable or replicated by design;
- do not use process memory as the only source of durable coordination;
- make instance-specific caches optional accelerators, not authorities.

Session affinity/stickiness MAY be used when justified, but it reduces scheduling flexibility and should not silently become a correctness requirement.

## 27.8 Find the bottleneck before adding capacity

Throughput is limited by the constrained resource, not by the number of front-end instances.

Typical bottlenecks include:

- database locks or connection limits;
- one serialized coordinator;
- hot partitions/keys;
- third-party rate limits;
- queue consumer throughput;
- CPU-heavy transformations;
- memory pressure/GC;
- storage IOPS;
- network bandwidth;
- synchronous fan-out;
- global mutexes/critical sections.

Before scaling out:

- measure traffic, latency, saturation, queue depth, and error behavior;
- identify the constrained resource;
- determine whether the constraint can be removed, partitioned, cached, batched, or made asynchronous;
- then add capacity where it actually increases throughput.

Do not use autoscaling as a substitute for understanding the system.

## 27.9 Separate workloads with different scaling characteristics

A public API, report generator, image/video processor, scheduler, import pipeline, and email sender may have completely different resource profiles.

Do not force them to scale together when one workload dominates resources.

A common evolution is:

```
request path -> enqueue durable work -> worker pool
```

This can isolate resource-intensive or latency-insensitive work and let each side scale independently.

Keep user-facing synchronous paths for work whose result is required immediately. Offload naturally asynchronous work such as notifications, exports, indexing, large transformations, and non-critical integrations when doing so improves latency or resilience.

## 27.10 Queues absorb bursts; they do not create infinite capacity

A queue turns immediate overload into backlog. That is useful only if the backlog can be drained within the required time.

For every queue, define:

- producer rate;
- sustainable consumer rate;
- maximum acceptable age/lag;
- maximum backlog/storage;
- retry/dead-letter policy;
- duplicate handling/idempotency;
- ordering requirements;
- visibility/lease timeout;
- poison-message policy;
- overload behavior when backlog exceeds limits.

Monitor age of oldest work in addition to queue length. A queue of 100 items can be healthy or disastrous depending on whether each item takes 1 ms or 10 minutes.

## 27.11 Apply backpressure and load shedding

Unbounded work intake eventually turns overload into an outage.

When consumers cannot keep up, use an intentional control mechanism:

- bounded queues;
- concurrency limits;
- per-tenant/per-client quotas;
- rate limits;
- admission control;
- priority classes;
- producer backpressure;
- fast rejection with retry guidance;
- graceful degradation of optional features.

Rejecting some work early can be safer than accepting everything and timing out after consuming expensive resources.

Backpressure SHOULD propagate toward the producer where the protocol allows it. Otherwise the overloaded component may spend most of its resources accepting work it cannot finish.

## 27.12 Minimize coordination on hot paths

Distributed coordination is expensive and often limits scale.

Avoid designs where every request requires:

- a global lock;
- consensus across many services;
- a synchronous call to numerous downstream systems;
- cross-region writes;
- one central sequence generator when uniqueness is sufficient;
- a distributed transaction when local ownership plus durable messaging can satisfy the invariant.

When strong coordination is genuinely required, make that requirement explicit and concentrate it around the smallest critical invariant.

Do not weaken financial, security, or consistency requirements merely to avoid coordination. Instead isolate the coordinated section and scale everything around it independently.

## 27.13 Partition around real limits

Eventually a single database/table/queue/worker class may hit a physical or administrative limit.

Partition by a key that spreads load and preserves common access patterns.

Possible boundaries include:

- tenant/account;
- geographic region;
- time window;
- entity hash/range;
- business domain;
- workload class.

A good partition key:

- distributes expected load;
- avoids a few hot keys;
- supports the most common queries without scatter-gather across every partition;
- permits growth/rebalancing;
- does not expose a security boundary accidentally;
- has an operational story for moving data.

Do not shard early merely because the database might grow. Sharding adds routing, migrations, cross-partition query complexity, rebalancing, and incident modes.

## 27.14 Data ownership matters more as the system distributes

Inside one process, joining and updating several tables can be cheap and transactional. Across independently deployed services, direct shared-database mutation creates hidden coupling.

As a default for independently owned services:

- one service/context owns writes to its authoritative data;
- other contexts use an API, event, read model, or replicated projection;
- cross-service joins are replaced by purpose-built read models when scale/latency requires it;
- schema changes are owned and versioned by the producer;
- consumers do not depend on private table layout.

This does not mean every service requires a physically separate database server. Logical ownership is the essential property; physical isolation depends on scale, risk, cost, and operational needs.

## 27.15 Accept that distributed consistency is different

Once one operation spans independently failing systems, a single local transaction often cannot cover the whole workflow.

Use patterns such as:

- transactional outbox;
- idempotent consumers;
- durable workflow/state machine;
- saga/compensating action where appropriate;
- reconciliation jobs;
- versioned events;
- monotonic state transitions;
- deduplication keys.

Assume:

- messages can be delayed;
- messages can be duplicated;
- consumers can process at different speeds;
- one side can succeed while another is unavailable;
- retries can arrive after the original result;
- ordering is not globally guaranteed unless the infrastructure explicitly provides and preserves it.

Design the business invariant for those realities rather than hoping the network behaves like a function call.

## 27.16 Version contracts for independent evolution

As systems and teams scale, simultaneous deployment becomes harder.

Prefer backward-compatible evolution:

- add the new field/endpoint/event behavior;
- deploy producers/servers that support old and new contracts;
- migrate consumers;
- observe adoption;
- remove the old contract only after it is no longer used.

This expand/migrate/contract approach applies to:

- APIs;
- database schemas;
- events/messages;
- configuration formats;
- stored files;
- feature flags/protocol versions.

Avoid "flag-day" changes where every component must upgrade at the same instant unless the deployment system actually guarantees atomic rollout.

## 27.17 Design for graceful scale-in and shutdown

Autoscaling and deployments remove instances as well as add them.

A scalable worker/server SHOULD:

- stop accepting new work on shutdown;
- signal unhealthy/not-ready before termination where the platform supports it;
- finish or safely abandon in-flight work within a deadline;
- release leases/locks;
- persist checkpoints for long jobs;
- make abandoned work reclaimable;
- flush critical telemetry without blocking indefinitely;
- tolerate clients retrying interrupted requests.

If killing one instance loses irreplaceable state, the architecture is not safely horizontally scalable.

## 27.18 Autoscale from demand signals that predict pressure

CPU can be useful, but it is not a universal scaling signal.

Depending on the workload, better signals may be:

- requests per second per instance;
- concurrent requests;
- queue depth;
- age of oldest queued item;
- active jobs;
- event lag;
- connection utilization;
- memory pressure;
- service-specific saturation.

Use enough headroom that new capacity becomes ready before existing capacity collapses.

Scale-out and scale-in SHOULD use different aggressiveness when rapid removal would cause thrashing. Capacity addition is often urgent; capacity removal can be conservative.

Autoscaling MUST remain bounded by downstream capacity. Adding 100 API instances that all open database connections can overload the database faster.

## 27.19 Redundancy and scale are related but not identical

Two instances can provide more capacity and remove one process as a single point of failure, but reliability depends on failure domains.

Replicas on the same host, rack, zone, region, database, identity provider, or network path may share the same failure.

Choose redundancy according to the required availability:

- process/instance redundancy;
- host redundancy;
- zone/datacenter redundancy;
- regional redundancy;
- provider independence only when the business case justifies its large complexity cost.

Do not spend multi-region complexity on a system whose recovery objective is comfortably met by backups plus a single-region redundant deployment.

## 27.20 Observability becomes more important as locality decreases

A monolith can often be debugged from one stack trace. A distributed request may touch many processes and asynchronous workers.

As distribution grows, standardize:

- correlation/trace IDs;
- structured logs;
- service/workload identity;
- request/job outcome metrics;
- latency histograms;
- queue lag/backlog;
- saturation/resource metrics;
- dependency telemetry;
- version/deployment metadata;
- distributed tracing where it answers real cross-service questions.

Every service boundary added without an observability story increases mean time to diagnose.

## 27.21 Test scale properties, not just functional correctness

Unit tests cannot reveal all large-scale failure modes.

Important systems SHOULD add targeted tests for:

- load/throughput;
- latency under expected concurrency;
- burst behavior;
- backlog drain rate;
- memory growth over long runs;
- connection pool exhaustion;
- dependency slowdown/timeouts;
- retry storms;
- cache loss/cold start;
- partial instance failure;
- rolling deployment compatibility;
- schema/message version compatibility;
- failover/recovery procedures.

Do not run maximal destructive load against production casually. Build repeatable performance environments or controlled production experiments appropriate to the risk.

## 27.22 Capacity planning needs numbers

Do not say "this should scale" without a workload model.

Record at least approximate values for:

- peak requests/jobs per second
- average and p95/p99 service time
- concurrency
- payload size
- read/write ratio
- data growth per day/month/year
- retention
- queue burst size and drain target
- downstream quotas
- connection limits
- CPU/memory per unit of work
- required availability and recovery targets

Then measure the real system and update the model.

Capacity planning is not prediction with perfect accuracy. It is knowing which resource reaches its limit first, how much headroom exists, and what action is taken before that limit becomes an incident.

## 27.23 Scale teams with boundaries and ownership, not meetings

As more engineers work on a system, unclear ownership produces coordination overhead.

Each substantial domain/module SHOULD have:

- a clear owner/team;
- an explicit public contract;
- documented invariants;
- tests close to the behavior;
- operational dashboards/runbooks where production-critical;
- a migration/deprecation policy;
- a place for architectural decisions that affect other teams.

Do not make every team consult every other team for normal changes. The architecture should allow most work to remain local.

At the same time, do not duplicate foundational concerns such as identity, security controls, observability standards, and deployment safety independently without governance. Centralize platform capability where consistency is more valuable than domain autonomy.

## 27.24 Repositories and deployment units do not need to match one-to-one

A large system can use:

- monorepo with many deployment units;
- monorepo with one deployment unit;
- multiple repositories with shared generated contracts;
- one repository per service only when organizational/tooling needs justify it.

Choose repository structure around developer workflow, ownership, atomic changes, build performance, and access controls.

Do not split repositories simply to claim architectural separation. Enforce module boundaries with dependency rules, visibility, package boundaries, build targets, and ownership whether code is physically together or apart.

## 27.25 Avoid the distributed-monolith trap

Warning signs:

- one user request synchronously fans out through many mandatory services;
- all services share one database schema and write each other's tables;
- services import each other's internal libraries/models;
- every deployment requires coordinated releases;
- one service outage makes nearly every other service unavailable;
- there is no idempotency/retry model;
- local development requires the entire company stack;
- boundaries are based on CRUD entities rather than cohesive capabilities;
- chatty per-row remote calls replace local joins/function calls.

When these appear, either restore stronger autonomy or merge components whose separation provides no benefit.

A network boundary is expensive. It should buy something.

## 27.26 Scale security boundaries deliberately

Distribution expands the attack surface.

For each new service/component:

- authenticate workload identity;
- authorize the specific operation, not merely the caller's existence;
- use least-privilege credentials;
- isolate tenant/customer data correctly;
- protect service-to-service secrets/keys;
- validate input even from internal networks when crossing trust boundaries;
- establish rate/resource limits;
- define audit events for sensitive operations;
- patch and inventory the new runtime/dependency surface.

"Internal service" is not a security model.

## 27.27 Cost is a scaling constraint

A design that scales technically but costs 20 times the value of the workload is not successful.

Track unit economics where relevant:

- cost per request
- cost per job
- cost per active user/tenant
- storage cost per retained GB
- network/egress per workflow
- idle baseline cost
- observability cost

Prefer architectural optimizations that improve both efficiency and clarity: batching, appropriate data structures, lifecycle/retention policy, async utilization, avoiding duplicate work, and right-sizing.

Do not sacrifice correctness or resilience blindly for cost. Make the trade-off explicit against SLOs and business requirements.

## 27.28 Know when to extract a service

Service extraction is justified when one or more strong conditions exist:

- a domain has a clear independent owner and contract;
- it needs independent deployment velocity;
- it has a materially different scaling profile;
- it needs stronger security/failure isolation;
- it requires a different runtime/technology for a concrete reason;
- its release lifecycle must be independent;
- the monolith's build/deploy/resource model creates a measured bottleneck;
- the boundary is already stable and cohesive inside the existing codebase.

Weak reasons:

- "microservices are more scalable";
- the source file became large;
- each database table should have a service;
- another company uses them;
- an agent can generate the boilerplate cheaply.

AI lowers the cost of writing service scaffolding. It does not lower the fundamental cost of network failure, distributed data consistency, observability, on-call burden, compatibility, or security boundaries.

## 27.29 Large-scale decision table

Use this as a default diagnosis:

```
Problem: one process lacks CPU
First move: profile, optimize major hotspots, then replicate/parallelize if safe

Problem: web/API tier overloaded but database healthy
First move: make instances interchangeable and scale horizontally

Problem: database is bottleneck
First move: inspect queries/indexes/locks/data model; add caching/read replicas/partitioning only as justified

Problem: bursty background work
First move: durable queue + bounded independently scalable workers

Problem: one workload starves another
First move: isolate resource pools/queues/concurrency; scale separately

Problem: codebase hard to change
First move: establish module/domain ownership and dependency boundaries, not network services

Problem: teams block each other's deployments
First move: identify stable business boundaries; consider independent deployment after contracts/data ownership are clear

Problem: one service has radically different scale/security needs
First move: consider extraction behind an owned contract

Problem: downstream dependency overloads
First move: concurrency limits, backpressure, timeouts, bounded retries, cache/fallback/degradation as semantics permit

Problem: hot tenant/key/partition
First move: isolate/partition/rate-limit the hotspot based on access pattern

Problem: scale-out causes duplicate effects
First move: idempotency/deduplication/atomic claim semantics before adding workers

Problem: autoscaling reacts too late
First move: scale on leading saturation/queue/concurrency signals and preserve headroom
```

## 27.30 Scaling checklist for coding agents

Before introducing "scalable architecture," an agent MUST be able to answer:

- Which dimension is expected to grow?
- What is the current or expected numeric load?
- Where is the present bottleneck?
- Can the current monolith/module simply be replicated?
- Is durable state tied to one process?
- Which work can be asynchronous?
- What backpressure exists when producers outrun consumers?
- What are the authoritative data owners?
- Which operations require strong consistency?
- Which operations must be idempotent?
- What happens when one instance terminates mid-operation?
- Which metric should trigger scaling?
- Which downstream resource limits total capacity?
- Does partitioning have a key that avoids hotspots?
- Can producer and consumer contracts evolve independently?
- Is a proposed service genuinely autonomous or only physically separate?
- How will cross-component requests be traced and diagnosed?
- How will load, failover, and recovery be tested?
- What new security boundary is created?
- What operational/on-call burden is being added?
- What is the cost per unit of useful work?
- If these questions have no concrete answer, keep the design simpler and gather measurements before adding distribution.
