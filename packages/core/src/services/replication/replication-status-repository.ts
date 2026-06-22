import type { TenantContext } from '@atlas/types';
import type { ReplicationStatusRecord } from '@atlas/types';

const STATUS_PREFIX = '_meta/replication/';

/** Builds the S3 key for a replication status sidecar. */
function status_key(owner_id: string, snapshot_id: string, target_id: string): string {
  return `${STATUS_PREFIX}${owner_id}/${snapshot_id}/${target_id}.json`;
}

/** Persists an encrypted replication status sidecar to primary storage. */
export async function save_replication_status(
  ctx: TenantContext,
  record: ReplicationStatusRecord,
): Promise<void> {
  const key = status_key(record.owner_id, record.snapshot_id, record.target_id);
  const plaintext = Buffer.from(JSON.stringify(record), 'utf-8');
  const ciphertext = ctx.encrypt(plaintext);
  await ctx.storage.put(key, ciphertext);
}

/** Loads a single replication status sidecar, or undefined if not found. */
export async function load_replication_status(
  ctx: TenantContext,
  owner_id: string,
  snapshot_id: string,
  target_id: string,
): Promise<ReplicationStatusRecord | undefined> {
  const key = status_key(owner_id, snapshot_id, target_id);
  return decrypt_status_record(ctx, key);
}

/** Lists all replication status records across the entire tenant. */
export async function list_all_replication_status(
  ctx: TenantContext,
): Promise<ReplicationStatusRecord[]> {
  return list_and_decrypt(ctx, STATUS_PREFIX);
}

/** Lists replication status records for a specific mailbox owner. */
export async function list_replication_status_by_owner(
  ctx: TenantContext,
  owner_id: string,
): Promise<ReplicationStatusRecord[]> {
  return list_and_decrypt(ctx, `${STATUS_PREFIX}${owner_id}/`);
}

/** Lists replication status records for a specific snapshot across all targets. */
export async function list_replication_status_by_snapshot(
  ctx: TenantContext,
  snapshot_id: string,
): Promise<ReplicationStatusRecord[]> {
  const all = await list_all_replication_status(ctx);
  return all.filter((r) => r.snapshot_id === snapshot_id);
}

async function list_and_decrypt(
  ctx: TenantContext,
  prefix: string,
): Promise<ReplicationStatusRecord[]> {
  const keys = await ctx.storage.list(prefix);
  const records: ReplicationStatusRecord[] = [];

  for (const key of keys) {
    const record = await decrypt_status_record(ctx, key);
    if (record) records.push(record);
  }

  return records;
}

async function decrypt_status_record(
  ctx: TenantContext,
  key: string,
): Promise<ReplicationStatusRecord | undefined> {
  try {
    const exists = await ctx.storage.exists(key);
    if (!exists) return undefined;
    const ciphertext = await ctx.storage.get(key);
    const plaintext = ctx.decrypt(ciphertext);
    return JSON.parse(plaintext.toString('utf-8')) as ReplicationStatusRecord;
  } catch {
    return undefined;
  }
}
