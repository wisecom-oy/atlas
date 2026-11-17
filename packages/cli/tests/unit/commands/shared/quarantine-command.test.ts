import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import {
  execute_quarantine,
  type QuarantineCommandSpec,
} from '@/commands/shared/quarantine.command';

const TOKEN = Symbol.for('TestQuarantineUseCase');

/** Runs the command for one workload and returns the warnings it logged. */
async function warnings_after_quarantine(
  workload: QuarantineCommandSpec['workload'],
  kind: 'manifest' | 'version_index',
): Promise<string> {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const container = new Container();
  container.bind(ATLAS_CONFIG_TOKEN).toConstantValue({ tenant_id: 'test-tenant' });
  container.bind(TOKEN).toConstantValue({
    quarantine_unreadable_object: vi.fn().mockResolvedValue({
      kind,
      storage_key: `${workload}/manifests/owner/snap-1.json`,
      quarantine_key: `_quarantine/${workload}/manifests/owner/snap-1.json`,
      reason: 'does not decrypt',
    }),
  });

  await execute_quarantine(
    container,
    { workload, object_noun: 'manifest', token: TOKEN },
    { key: `${workload}/manifests/owner/snap-1.json` },
  );
  return warn.mock.calls.map(([message]) => String(message)).join('\n');
}

describe('what quarantine tells the operator to do next', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Issue #725: the drive cursor names the snapshot it was saved with, so the backup after a
  // quarantined newest manifest reads in full without being told to.
  it.each(['onedrive', 'sharepoint'] as const)(
    'says a quarantined newest %s snapshot needs no manual full backup, an older one does',
    async (workload) => {
      const warnings = await warnings_after_quarantine(workload, 'manifest');

      expect(warnings).toContain('If this was the newest snapshot, the next backup reads every');
      expect(warnings).toContain('by itself');
      expect(warnings).toContain(`If newer snapshots exist`);
      expect(warnings).toContain(`atlas ${workload} backup --full`);
    },
  );

  it('still asks for a full Outlook backup after a quarantined manifest', async () => {
    const warnings = await warnings_after_quarantine('outlook', 'manifest');

    expect(warnings).toContain('atlas outlook backup --full');
    expect(warnings).not.toContain('by itself');
  });

  it('keeps the version index warning for a drive workload', async () => {
    const warnings = await warnings_after_quarantine('onedrive', 'version_index');

    expect(warnings).toContain('list-versions');
    expect(warnings).not.toContain('backup --full');
  });
});
