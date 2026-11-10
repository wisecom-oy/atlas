import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import type { CalendarEventEntry } from '@wisecom/atlas-types';
import {
  in_memory_tenant_context,
  type InMemoryTenantContext,
} from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { memory_calendar_manifests } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import {
  MAILBOX,
  SNAPSHOT,
  TENANT,
  save_snapshot,
  stored_event,
  stored_file,
} from '@wisecom/atlas-types/testing/stub-calendar-snapshots';
import { tenant_factory_for } from '@wisecom/atlas-types/testing/stub-contacts-ports';

import { CalendarVerificationService } from '@/services/verification/verification.service';

/** Moves plaintext objects into the bucket, encrypted with real AES-256-GCM under their keys. */
function encrypt_into(harness: InMemoryTenantContext, plaintext: Record<string, Buffer>): void {
  for (const [key, bytes] of Object.entries(plaintext)) {
    harness.set_raw(key, harness.ctx.encrypt(bytes, key));
  }
}

/** Flips the last ciphertext byte, which the GCM tag check rejects. */
function flip_last_byte(harness: InMemoryTenantContext, key: string): void {
  const bytes = Buffer.from(harness.raw(key) ?? Buffer.alloc(0));
  bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
  harness.set_raw(key, bytes);
}

/** Two events, the first with a file attachment, stored encrypted. */
function encrypted_events(harness: InMemoryTenantContext): CalendarEventEntry[] {
  const plaintext: Record<string, Buffer> = {};
  const attachment = stored_file(plaintext, 'a1', 'agenda.pdf', 'agenda');
  const entries = [
    stored_event(plaintext, 'src-default', { id: 'e1', type: 'singleInstance' }, [attachment]),
    stored_event(plaintext, 'src-default', { id: 'e2', type: 'singleInstance' }),
  ];
  encrypt_into(harness, plaintext);
  return entries;
}

/** Runs full verification of a snapshot over the given entries. */
async function verify_full(harness: InMemoryTenantContext, entries: CalendarEventEntry[]) {
  const manifests = memory_calendar_manifests();
  save_snapshot(manifests, entries);
  const service = new CalendarVerificationService(tenant_factory_for(harness.ctx), manifests);
  return service.verify_calendar_snapshot(TENANT, MAILBOX, SNAPSHOT, { fast: false });
}

describe('CalendarVerificationService with tampered ciphertext', () => {
  it('lists every object that fails its GCM tag and keeps checking the rest', async () => {
    const harness = in_memory_tenant_context();
    const entries = encrypted_events(harness);
    const attachment_key = entries[0]?.attachments?.[0]?.storage_key ?? '';
    const tampered = [attachment_key, entries[1]?.storage_key ?? ''];
    tampered.forEach((key) => flip_last_byte(harness, key));

    const result = await verify_full(harness, entries);

    expect(result.total_checked).toBe(3);
    expect(result.passed).toBe(1);
    expect(result.failed).toEqual(tampered);
  });

  it('fails a truncated object shorter than the GCM header', async () => {
    const harness = in_memory_tenant_context();
    const entries = encrypted_events(harness);
    const truncated = entries[0]?.storage_key ?? '';
    harness.set_raw(truncated, Buffer.from('short'));

    const result = await verify_full(harness, entries);

    expect(result.failed).toEqual([truncated]);
    expect(result.passed).toBe(2);
  });

  it('propagates a storage error that is not an absent key', async () => {
    const harness = in_memory_tenant_context();
    const entries = encrypted_events(harness);
    const outage = Object.assign(new Error('Service Unavailable'), { name: 'ServiceUnavailable' });
    harness.ctx.storage.get = async () => {
      throw outage;
    };

    await expect(verify_full(harness, entries)).rejects.toBe(outage);
  });
});
