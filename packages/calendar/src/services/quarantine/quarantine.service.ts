import { inject, injectable } from 'inversify';
import type {
  CalendarManifestRepository,
  QuarantinedObjectKind,
  QuarantineResult,
  QuarantineUseCase,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  CALENDAR_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  quarantine_unreadable_object,
  type QuarantineTarget,
} from '@wisecom/atlas-core/services/quarantine/stored-object-quarantine';
import { calendar_delta_cursor_key, calendar_manifest_key } from '@/services/shared/storage-keys';

/** A calendar snapshot manifest: `calendar/manifests/{mailbox}/{snapshot}.json`. */
const MANIFEST_KEY = /^calendar\/manifests\/([^/]+)\/([^/]+)\.json$/;

/** The mailbox segment of a key Atlas would write exactly as given, else undefined. */
function mailbox_of(storage_key: string): string | undefined {
  const match = MANIFEST_KEY.exec(storage_key);
  if (!match) return undefined;
  const [, mailbox = '', snapshot_id = ''] = match;
  try {
    return calendar_manifest_key(mailbox, snapshot_id) === storage_key ? mailbox : undefined;
  } catch {
    return undefined;
  }
}

/** Moves an unreadable calendar manifest aside (issue #631). */
@injectable()
export class CalendarQuarantineService implements QuarantineUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(CALENDAR_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: CalendarManifestRepository,
  ) {}

  /**
   * Moves the manifest at `storage_key` to `_quarantine/`, refusing one that reads cleanly, then
   * removes the mailbox's delta cursor. The cursor's links may describe the snapshot just moved
   * aside; resuming them on top of an older manifest would drop every change between the two, so
   * the next backup reads every calendar in full instead.
   */
  async quarantine_unreadable_object(
    tenant_id: string,
    storage_key: string,
  ): Promise<QuarantineResult> {
    const target: QuarantineTarget = {
      workload: 'Calendar',
      accepts: 'Calendar manifests',
      kind_of: (key): QuarantinedObjectKind | undefined =>
        mailbox_of(key) === undefined ? undefined : 'manifest',
      read: (ctx, key) => this._manifests.read_manifest_at(ctx, key),
      after_move: (ctx, key) => drop_cursor(ctx, key),
    };
    return quarantine_unreadable_object(this._tenant_factory, target, tenant_id, storage_key);
  }
}

/** Removes the delta cursor of the mailbox a moved manifest belonged to. */
async function drop_cursor(ctx: TenantContext, storage_key: string): Promise<void> {
  const mailbox = mailbox_of(storage_key);
  if (mailbox !== undefined) await ctx.storage.delete(calendar_delta_cursor_key(mailbox));
}
