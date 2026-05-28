/**
 * Smoke test for Graph API cost tracking.
 *
 * Verifies that the request counter, pool attribution, and rate-limiting
 * decorator chain all behave correctly end-to-end without a real Graph
 * connection. Run with:
 *
 *   npx tsx --tsconfig tsconfig.json scripts/smoke-cost-tracking.ts
 */

import { GraphRequestCounter } from '../src/services/shared/graph-request-counter';
import {
  run_with_cost_tracking,
  get_active_counter,
} from '../src/services/shared/graph-request-context';
import { GRAPH_SERVICE_LIMITS } from '../src/domain/graph-service-limits-values';
import { RateLimitedGraphConnector } from '../src/adapters/m365/rate-limited-graph-connector.adapter';
import { CostTrackingRestoreConnector } from '../src/adapters/m365/cost-tracking-restore-connector.adapter';
import { ThrottleFence } from '../src/services/shared/throttle-fence';
import { DefaultMailboxRateLimiterFactory } from '../src/services/shared/mailbox-rate-limiter';
import type { MailboxConnector } from '../src/ports/mailbox/connector.port';
import type { RestoreConnector } from '../src/ports/restore/connector.port';
import type { OperationCost } from '../src/domain/graph-cost';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(label: string, value: unknown, expected: unknown): void {
  const ok = JSON.stringify(value) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    console.error(`     expected: ${JSON.stringify(expected)}`);
    console.error(`     received: ${JSON.stringify(value)}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ---------------------------------------------------------------------------
// Stub connectors (no real Graph calls)
// ---------------------------------------------------------------------------

function make_mailbox_stub(): MailboxConnector {
  return {
    list_mailboxes: async () => ['alice@example.com', 'bob@example.com'],
    mailbox_exists: async () => true,
    list_mail_folders: async () => [
      { folder_id: 'inbox', display_name: 'Inbox', total_item_count: 100 },
      { folder_id: 'sent', display_name: 'Sent Items', total_item_count: 50 },
    ],
    fetch_delta: async () => ({
      messages: [],
      removed_ids: [],
      delta_link: 'https://graph.microsoft.com/v1.0/$delta?token=abc123',
      delta_reset: false,
    }),
    fetch_message: async () => ({
      message_id: 'msg-1',
      subject: 'Test',
      body: '',
      raw_body: '',
      received_at: new Date(),
      sent_at: new Date(),
      from: '',
      to: [],
      cc: [],
      bcc: [],
      reply_to: [],
      has_attachments: false,
      folder_id: 'inbox',
      internet_message_id: '',
      is_draft: false,
      created_at: new Date(),
      modified_at: new Date(),
    }),
    fetch_attachments: async () => [],
  };
}

function make_restore_stub(): RestoreConnector {
  return {
    create_mail_folder: async () => ({
      folder_id: 'f-restore',
      display_name: 'Restored',
      total_item_count: 0,
    }),
    create_message: async () => 'new-msg-id',
    add_attachment: async () => undefined,
    create_upload_session: async () => ({
      upload_url: 'https://upload.example.com/session',
      expiration: new Date(Date.now() + 60_000).toISOString(),
    }),
    upload_attachment_chunk: async () => undefined,
    count_folder_messages: async () => 5,
    list_folder_messages: async () => [],
  };
}

function make_decorated_mailbox(): RateLimitedGraphConnector {
  const fence = new ThrottleFence();
  const factory = new DefaultMailboxRateLimiterFactory(fence);
  return new RateLimitedGraphConnector(make_mailbox_stub(), factory, fence);
}

// ---------------------------------------------------------------------------
// Test 1: GraphRequestCounter basics
// ---------------------------------------------------------------------------

async function test_counter_basics(): Promise<void> {
  section('1. GraphRequestCounter — basic accumulation');

  const counter = new GraphRequestCounter();

  // No records yet
  const empty = counter.snapshot();
  assert('starts with zero requests_total', empty.requests_total, 0);
  assert('starts with empty by_service', empty.by_service, {});
  assert('starts with empty requests_by_type', empty.requests_by_type, {});

  // Single Outlook record
  counter.record('outlook', 'list_folders');
  const snap1 = counter.snapshot();
  assert('one request total after first record', snap1.requests_total, 1);
  assert('outlook pool has 1 request', snap1.by_service.outlook?.requests, 1);
  assert(
    'outlook pool has 1 resource_unit (flat cost)',
    snap1.by_service.outlook?.resource_units,
    1,
  );
  assert('outlook pool has 0 upload_bytes', snap1.by_service.outlook?.upload_bytes, 0);
  assert('requests_by_type has list_folders: 1', snap1.requests_by_type['list_folders'], 1);
  assert('identity pool absent', snap1.by_service.identity, undefined);

  // Add identity records with explicit RU costs
  counter.record('identity', 'list_users', { resource_units: 2 });
  counter.record('identity', 'mailbox_exists', { resource_units: 1 });
  const snap2 = counter.snapshot();
  assert('total is now 3', snap2.requests_total, 3);
  assert('identity pool has 2 requests', snap2.by_service.identity?.requests, 2);
  assert('identity pool has 3 resource_units (2+1)', snap2.by_service.identity?.resource_units, 3);

  // Add upload_bytes
  counter.record('outlook', 'upload_chunk', { upload_bytes: 4 * 1024 * 1024 });
  const snap3 = counter.snapshot();
  assert(
    'outlook pool upload_bytes accumulated',
    snap3.by_service.outlook?.upload_bytes,
    4 * 1024 * 1024,
  );
  assert('outlook pool now has 2 requests', snap3.by_service.outlook?.requests, 2);
}

// ---------------------------------------------------------------------------
// Test 2: AsyncLocalStorage isolation
// ---------------------------------------------------------------------------

async function test_async_isolation(): Promise<void> {
  section('2. AsyncLocalStorage — scoping and isolation');

  // No counter active outside of run_with_cost_tracking
  assert('get_active_counter is undefined outside context', get_active_counter(), undefined);

  // Counter is visible inside run_with_cost_tracking
  const [result, cost] = await run_with_cost_tracking(async () => {
    const counter = get_active_counter();
    if (!counter) throw new Error('Expected counter to be defined inside context');
    counter.record('outlook', 'delta_sync');
    counter.record('outlook', 'delta_sync');
    counter.record('identity', 'mailbox_exists', { resource_units: 1 });
    return 'done';
  });

  assert('fn result is propagated', result, 'done');
  assert('total requests accumulated', cost.requests_total, 3);
  assert('delta_sync counted twice', cost.requests_by_type['delta_sync'], 2);
  assert('mailbox_exists counted once', cost.requests_by_type['mailbox_exists'], 1);

  // Counter is gone again after the call
  assert('get_active_counter is undefined after context closes', get_active_counter(), undefined);

  // Concurrent calls use separate counters
  const [cost_a, cost_b] = await Promise.all([
    run_with_cost_tracking(async () => {
      await new Promise<void>((r) => setTimeout(r, 20));
      get_active_counter()?.record('outlook', 'delta_sync');
      return 'a';
    }).then(([, c]) => c),

    run_with_cost_tracking(async () => {
      get_active_counter()?.record('outlook', 'fetch_attachments');
      get_active_counter()?.record('outlook', 'fetch_attachments');
      return 'b';
    }).then(([, c]) => c),
  ]);

  assert('[concurrent A] saw only its own delta_sync', cost_a.requests_by_type['delta_sync'], 1);
  assert(
    "[concurrent A] did not see B's fetch_attachments",
    cost_a.requests_by_type['fetch_attachments'],
    undefined,
  );
  assert(
    '[concurrent B] saw only its own fetch_attachments x2',
    cost_b.requests_by_type['fetch_attachments'],
    2,
  );
  assert(
    "[concurrent B] did not see A's delta_sync",
    cost_b.requests_by_type['delta_sync'],
    undefined,
  );
}

// ---------------------------------------------------------------------------
// Test 3: RateLimitedGraphConnector pool attribution
// ---------------------------------------------------------------------------

async function test_pool_attribution(): Promise<void> {
  section('3. RateLimitedGraphConnector — correct pool attribution');

  const connector = make_decorated_mailbox();

  // list_mailboxes -> identity pool
  const [, cost_list] = await run_with_cost_tracking(() => connector.list_mailboxes('tenant-abc'));
  assert('list_mailboxes => identity pool', cost_list.by_service.identity?.requests, 1);
  assert(
    'list_mailboxes => identity: list_users label',
    cost_list.requests_by_type['list_users'],
    1,
  );
  assert('list_mailboxes => NOT outlook pool', cost_list.by_service.outlook, undefined);
  assert(
    'list_mailboxes => identity RU = users_list_cost (2)',
    cost_list.by_service.identity?.resource_units,
    GRAPH_SERVICE_LIMITS.identity.users_list_cost,
  );

  // mailbox_exists -> identity pool
  const [, cost_exists] = await run_with_cost_tracking(() =>
    connector.mailbox_exists('tenant-abc', 'alice@example.com'),
  );
  assert('mailbox_exists => identity pool', cost_exists.by_service.identity?.requests, 1);
  assert(
    'mailbox_exists => identity: mailbox_exists label',
    cost_exists.requests_by_type['mailbox_exists'],
    1,
  );
  assert('mailbox_exists => NOT outlook pool', cost_exists.by_service.outlook, undefined);

  // list_mail_folders -> outlook pool
  const [, cost_folders] = await run_with_cost_tracking(() =>
    connector.list_mail_folders('tenant-abc', 'alice@example.com'),
  );
  assert('list_mail_folders => outlook pool', cost_folders.by_service.outlook?.requests, 1);
  assert(
    'list_mail_folders => outlook: list_folders label',
    cost_folders.requests_by_type['list_folders'],
    1,
  );
  assert('list_mail_folders => NOT identity pool', cost_folders.by_service.identity, undefined);

  // fetch_delta -> outlook pool
  const [, cost_delta] = await run_with_cost_tracking(() =>
    connector.fetch_delta('tenant-abc', 'alice@example.com', 'inbox'),
  );
  assert('fetch_delta => outlook pool', cost_delta.by_service.outlook?.requests, 1);
  assert('fetch_delta => outlook: delta_sync label', cost_delta.requests_by_type['delta_sync'], 1);

  // fetch_attachments -> outlook pool
  const [, cost_attach] = await run_with_cost_tracking(() =>
    connector.fetch_attachments('tenant-abc', 'alice@example.com', 'msg-1'),
  );
  assert('fetch_attachments => outlook pool', cost_attach.by_service.outlook?.requests, 1);
  assert(
    'fetch_attachments => outlook: fetch_attachments label',
    cost_attach.requests_by_type['fetch_attachments'],
    1,
  );
}

// ---------------------------------------------------------------------------
// Test 4: CostTrackingRestoreConnector
// ---------------------------------------------------------------------------

async function test_restore_connector(): Promise<void> {
  section('4. CostTrackingRestoreConnector — outlook pool for all restore ops');

  const connector = new CostTrackingRestoreConnector(make_restore_stub());

  const [, cost] = await run_with_cost_tracking(async () => {
    await connector.create_mail_folder('tenant', 'alice@example.com', 'Restored-2026');
    await connector.create_message('tenant', 'alice@example.com', 'f-restore', {});
    await connector.create_message('tenant', 'alice@example.com', 'f-restore', {});
    await connector.add_attachment('tenant', 'alice@example.com', 'msg-1', {
      name: 'report.pdf',
      content_type: 'application/pdf',
      content: Buffer.alloc(2048),
      is_inline: false,
      content_id: '',
    });
    await connector.create_upload_session(
      'tenant',
      'alice@example.com',
      'msg-2',
      'large.zip',
      10_000_000,
    );
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    await connector.upload_attachment_chunk('https://upload-url', chunk, 0, chunk.length);
    await connector.count_folder_messages('tenant', 'alice@example.com', 'f-restore');
  });

  assert('all 7 restore calls => outlook pool', cost.by_service.outlook?.requests, 7);
  assert('no identity requests during restore', cost.by_service.identity, undefined);
  assert('create_folder counted', cost.requests_by_type['create_folder'], 1);
  assert('create_message counted x2', cost.requests_by_type['create_message'], 2);
  assert('add_attachment counted', cost.requests_by_type['add_attachment'], 1);
  assert('create_upload_session counted', cost.requests_by_type['create_upload_session'], 1);
  assert('upload_chunk counted', cost.requests_by_type['upload_chunk'], 1);
  assert('count_folder_messages counted', cost.requests_by_type['count_folder_messages'], 1);

  const expected_upload_bytes = 2048 + 4 * 1024 * 1024;
  assert(
    'upload_bytes sums add_attachment + chunk',
    cost.by_service.outlook?.upload_bytes,
    expected_upload_bytes,
  );
}

// ---------------------------------------------------------------------------
// Test 5: Simulated full backup job (realistic scenario)
// ---------------------------------------------------------------------------

async function test_simulated_backup_job(): Promise<void> {
  section('5. Simulated mailbox backup — realistic cost shape');

  const mailbox = make_decorated_mailbox();
  const MAILBOX_ID = 'alice@contoso.com';
  const TENANT_ID = 'tenant-xyz';
  const FOLDER_COUNT = 5;
  const MESSAGES_PER_FOLDER = 40;
  const ATTACHMENTS_PER_MSG = 2;

  const [, cost] = await run_with_cost_tracking(async () => {
    // 1. Check mailbox exists (identity)
    await mailbox.mailbox_exists(TENANT_ID, MAILBOX_ID);

    // 2. List folders (outlook)
    await mailbox.list_mail_folders(TENANT_ID, MAILBOX_ID);

    // 3. Delta sync each folder (outlook) - one call per folder
    for (let f = 0; f < FOLDER_COUNT; f++) {
      await mailbox.fetch_delta(TENANT_ID, MAILBOX_ID, `folder-${f}`);
    }

    // 4. Fetch attachments for each message in each folder (outlook)
    for (let f = 0; f < FOLDER_COUNT; f++) {
      for (let m = 0; m < MESSAGES_PER_FOLDER; m++) {
        if (m < ATTACHMENTS_PER_MSG * 10) {
          await mailbox.fetch_attachments(TENANT_ID, MAILBOX_ID, `msg-${f}-${m}`);
        }
      }
    }
  });

  const expected_identity = 1; // mailbox_exists
  const expected_outlook = 1 + FOLDER_COUNT + ATTACHMENTS_PER_MSG * 10 * FOLDER_COUNT;
  // = list_mail_folders(1) + delta(5) + fetch_attachments(100)

  assert(
    'identity requests = 1 (mailbox_exists)',
    cost.by_service.identity?.requests,
    expected_identity,
  );
  assert(
    `outlook requests = ${expected_outlook}`,
    cost.by_service.outlook?.requests,
    expected_outlook,
  );
  assert('total = identity + outlook', cost.requests_total, expected_identity + expected_outlook);
  assert('elapsed_ms is positive', (cost.elapsed_ms ?? 0) >= 0, true);

  // Cooldown calculation matches the GRAPH_SERVICE_LIMITS constant
  const limits = GRAPH_SERVICE_LIMITS.outlook;
  const usage_ratio = (cost.by_service.outlook?.requests ?? 0) / limits.requests_per_window;
  const cooldown_ms = Math.ceil(usage_ratio * limits.window_duration_ms);

  console.log(`\n  📊  Cost breakdown:`);
  console.log(
    `       Outlook  requests : ${cost.by_service.outlook?.requests}  / ${limits.requests_per_window}  (${(usage_ratio * 100).toFixed(3)}% of window)`,
  );
  console.log(
    `       Identity requests : ${cost.by_service.identity?.requests}  / ${limits.requests_per_window}  (Identity pool — different budget)`,
  );
  console.log(`       Total             : ${cost.requests_total}`);
  console.log(`       Elapsed           : ${cost.elapsed_ms}ms`);
  console.log(`       Suggested cooldown: ${cooldown_ms}ms  (${(cooldown_ms / 1000).toFixed(2)}s)`);
  console.log(
    `       By type           : ${JSON.stringify(cost.requests_by_type, null, 2).replace(/\n/g, '\n       ')}`,
  );
}

// ---------------------------------------------------------------------------
// Test 6: Calls outside tracking context produce no errors
// ---------------------------------------------------------------------------

async function test_no_context_is_safe(): Promise<void> {
  section('6. Outside-context calls — no errors, counter is a no-op');

  const mailbox = make_decorated_mailbox();
  const restore = new CostTrackingRestoreConnector(make_restore_stub());

  // Should not throw even though no AsyncLocalStorage context is active
  await mailbox.list_mailboxes('tenant');
  await mailbox.mailbox_exists('tenant', 'alice@example.com');
  await mailbox.list_mail_folders('tenant', 'alice@example.com');
  await mailbox.fetch_delta('tenant', 'alice@example.com', 'inbox');
  await restore.create_mail_folder('tenant', 'alice@example.com', 'Test');
  await restore.create_message('tenant', 'alice@example.com', 'f1', {});

  assert('no-context calls complete without error', true, true);
}

// ---------------------------------------------------------------------------
// Test 7: GRAPH_SERVICE_LIMITS constant shape
// ---------------------------------------------------------------------------

async function test_limits_constant(): Promise<void> {
  section('7. GRAPH_SERVICE_LIMITS — structure and values');

  const { outlook, sharepoint_onedrive, identity } = GRAPH_SERVICE_LIMITS;

  assert('outlook.pool === "outlook"', outlook.pool, 'outlook');
  assert('outlook.scope === "per_app_per_mailbox"', outlook.scope, 'per_app_per_mailbox');
  assert('outlook.requests_per_window === 10000', outlook.requests_per_window, 10_000);
  assert('outlook.window_duration_ms === 600000', outlook.window_duration_ms, 600_000);
  assert('outlook.max_concurrent_requests === 4', outlook.max_concurrent_requests, 4);
  assert(
    'outlook.upload_bytes_per_window === 157286400 (150MB)',
    outlook.upload_bytes_per_window,
    150 * 1024 * 1024,
  );

  assert('sp.pool === "sharepoint_onedrive"', sharepoint_onedrive.pool, 'sharepoint_onedrive');
  assert('sp.delta_with_token_cost === 1', sharepoint_onedrive.delta_with_token_cost, 1);
  assert('sp.delta_without_token_cost === 2', sharepoint_onedrive.delta_without_token_cost, 2);
  assert(
    'sp.resource_units_per_minute[0-1000] === 1250',
    sharepoint_onedrive.resource_units_per_minute['0-1000'],
    1_250,
  );
  assert(
    'sp.resource_units_per_minute[50000+] === 6250',
    sharepoint_onedrive.resource_units_per_minute['50000+'],
    6_250,
  );

  assert('identity.pool === "identity"', identity.pool, 'identity');
  assert('identity.resource_units_per_10s.S === 3500', identity.resource_units_per_10s['S'], 3_500);
  assert('identity.resource_units_per_10s.L === 8000', identity.resource_units_per_10s['L'], 8_000);
  assert('identity.users_list_cost === 2', identity.users_list_cost, 2);
  assert('identity.user_get_cost === 1', identity.user_get_cost, 1);
  assert(
    'identity.resource_units_per_20s_global === 150000',
    identity.resource_units_per_20s_global,
    150_000,
  );

  // Verify the objects are frozen (consumers cannot accidentally mutate)
  assert('GRAPH_SERVICE_LIMITS is frozen', Object.isFrozen(GRAPH_SERVICE_LIMITS), true);
  assert('outlook pool is frozen', Object.isFrozen(outlook), true);
  assert('sharepoint_onedrive pool is frozen', Object.isFrozen(sharepoint_onedrive), true);
  assert('identity pool is frozen', Object.isFrozen(identity), true);
}

// ---------------------------------------------------------------------------
// Test 8: OperationCost shape returned from run_with_cost_tracking
// ---------------------------------------------------------------------------

async function test_operation_cost_shape(): Promise<void> {
  section('8. OperationCost — shape of returned value');

  const [, cost]: [unknown, OperationCost] = await run_with_cost_tracking(async () => {
    get_active_counter()?.record('outlook', 'delta_sync');
    get_active_counter()?.record('identity', 'list_users', { resource_units: 2 });
  });

  assert('requests_total is a number', typeof cost.requests_total, 'number');
  assert('by_service is an object', typeof cost.by_service, 'object');
  assert('requests_by_type is an object', typeof cost.requests_by_type, 'object');
  assert('elapsed_ms is a number', typeof cost.elapsed_ms, 'number');
  assert('by_service.outlook is present', cost.by_service.outlook !== undefined, true);
  assert('by_service.identity is present', cost.by_service.identity !== undefined, true);
  assert(
    'by_service.sharepoint_onedrive is absent (unused)',
    cost.by_service.sharepoint_onedrive,
    undefined,
  );

  const outlook_cost = cost.by_service.outlook!;
  assert('ServicePoolCost has requests field', typeof outlook_cost.requests, 'number');
  assert('ServicePoolCost has resource_units field', typeof outlook_cost.resource_units, 'number');
  assert('ServicePoolCost has upload_bytes field', typeof outlook_cost.upload_bytes, 'number');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Graph API Cost Tracking — Smoke Test');
  console.log('═══════════════════════════════════════════════════════');

  await test_counter_basics();
  await test_async_isolation();
  await test_pool_attribution();
  await test_restore_connector();
  await test_simulated_backup_job();
  await test_no_context_is_safe();
  await test_limits_constant();
  await test_operation_cost_shape();

  console.log('\n═══════════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ✓  All ${passed} assertions passed`);
  } else {
    console.log(`  ✗  ${failed} failed / ${passed + failed} total`);
  }
  console.log('═══════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});
