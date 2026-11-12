import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  SharePointDeltaCursor,
  SharePointFileVersionIndexRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import type { RunVersionCollector } from '@/services/versioning/version-sync';

/**
 * Builds the run's version bookkeeping from the delta cursor.
 *
 * Steady state costs nothing: the cursor is one object the run already reads,
 * and it carries the dedup watermarks. Only a cursor written before
 * watermarks existed falls back to scanning the version index, once, to seed
 * them; from the next run on that site is on the cheap path (issue #161).
 */
export async function load_run_version_collector(
  file_indexes: SharePointFileVersionIndexRepository,
  ctx: TenantContext,
  site_id: string,
  stored_cursor: SharePointDeltaCursor | undefined,
): Promise<RunVersionCollector> {
  const carried = stored_cursor?.version_watermark_by_file_id;
  if (carried) return { watermarks: { ...carried }, rows: new Map() };
  logger.info(`Seeding version dedup watermarks for ${site_id} from the version index`);
  return {
    watermarks: await file_indexes.load_version_watermarks(ctx, site_id),
    rows: new Map(),
  };
}
