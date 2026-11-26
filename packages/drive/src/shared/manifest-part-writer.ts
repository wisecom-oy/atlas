import type { TenantContext } from '@wisecom/atlas-types';
import { AtlasError, RefusedWriteError } from '@wisecom/atlas-types';
import {
  write_encrypted_json,
  write_encrypted_json_text,
} from '@wisecom/atlas-core/services/shared/stored-json-writer';
import { BoundedTaskPool } from '@/shared/bounded-task-pool';
import {
  require_drive_manifest_document,
  type DriveManifestLayout,
  type DriveStoredManifest,
} from '@/shared/drive-manifest-document';
import { split_entries_by_size, type SerialisedEntryRun } from '@/shared/manifest-entry-runs';
import {
  build_manifest_part_text,
  digest_part_text,
  MANIFEST_PARTS_VERSION,
  require_manifest_part_entries,
  type ManifestEntryParts,
  type ManifestPartIdentity,
  type ManifestPartReference,
} from '@/shared/manifest-part-document';

const MIB = 1024 * 1024;

/** When a manifest is split into parts, and how the parts are written. */
export interface ManifestSizing {
  /** A manifest whose entries serialise to at most this many bytes stays one document. */
  readonly single_document_bytes: number;
  /** The most entry bytes one part holds, unless a single entry is larger on its own. */
  readonly part_bytes: number;
  /** Parts uploaded at once; each holds a few copies of up to `part_bytes` in memory. */
  readonly write_concurrency: number;
}

/** The sizing every backup uses; tests pass smaller values to cross the threshold cheaply. */
export const DEFAULT_MANIFEST_SIZING: ManifestSizing = Object.freeze({
  single_document_bytes: 32 * MIB,
  part_bytes: 8 * MIB,
  write_concurrency: 4,
});

/** A manifest with the entry list the writer splits. */
export interface DriveWritableManifest extends DriveStoredManifest {
  readonly entries: readonly unknown[];
}

/**
 * Writes a manifest as one document when its entries fit in `single_document_bytes`, which every
 * earlier Atlas reads, and otherwise as numbered entry parts followed by a head (#920).
 *
 * The head goes last and is the commit point: until it exists no reader sees the snapshot, so an
 * interrupted write leaves only parts that nothing references. Every part and the head are
 * create-only, carry the run's Object Lock retention, and are read back once they land.
 */
export async function write_drive_manifest_document(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  owner_id: string,
  manifest: DriveWritableManifest,
  sizing: ManifestSizing,
): Promise<void> {
  const head_key = layout.keys.manifest_key(owner_id, manifest.snapshot_id);
  if (!Array.isArray(manifest.entries)) {
    // Not a manifest at all: the reader check refuses it with the reason a reader would give.
    await write_manifest_document(ctx, layout, head_key, manifest);
    return;
  }
  const runs = guard_serialisation(
    split_entries_by_size(manifest.entries, sizing.part_bytes),
    head_key,
    `${layout.label} manifest`,
  );
  const leading = take_runs_within(runs, sizing.single_document_bytes);
  if (leading.exhausted) {
    await write_manifest_document(ctx, layout, head_key, manifest);
    return;
  }
  const parts = await write_entry_parts(
    ctx,
    layout,
    { owner_id, snapshot_id: manifest.snapshot_id },
    concat_runs(leading.runs, runs),
    sizing.write_concurrency,
  );
  await write_manifest_document(ctx, layout, head_key, build_manifest_head(manifest, parts));
}

/** The runs read before the total passed `limit`, and whether that was every run. */
interface LeadingRuns {
  readonly runs: SerialisedEntryRun[];
  readonly exhausted: boolean;
}

/** Reads runs until their total passes `limit` or they run out, leaving the rest unread. */
function take_runs_within(runs: Iterator<SerialisedEntryRun>, limit: number): LeadingRuns {
  const taken: SerialisedEntryRun[] = [];
  let total = 0;
  for (let next = runs.next(); !next.done; next = runs.next()) {
    taken.push(next.value);
    total += next.value.byte_length;
    if (total > limit) return { runs: taken, exhausted: false };
  }
  return { runs: taken, exhausted: true };
}

function* concat_runs(
  leading: SerialisedEntryRun[],
  rest: Iterator<SerialisedEntryRun>,
): Generator<SerialisedEntryRun> {
  while (leading.length > 0) yield leading.shift()!;
  for (let next = rest.next(); !next.done; next = rest.next()) yield next.value;
}

/** Raises an entry that cannot be serialised as a refused write of the manifest. */
function* guard_serialisation(
  runs: Iterator<SerialisedEntryRun>,
  key: string,
  label: string,
): Generator<SerialisedEntryRun> {
  for (;;) {
    let next: IteratorResult<SerialisedEntryRun>;
    try {
      next = runs.next();
    } catch (err) {
      if (err instanceof AtlasError) throw err;
      const reason = `an entry cannot be serialised as JSON (${String(err)})`;
      throw new RefusedWriteError(key, label, reason, { cause: err });
    }
    if (next.done) return;
    yield next.value;
  }
}

/** Writes each run as one numbered part, a few at a time, and returns what the head records. */
async function write_entry_parts(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  snapshot: { readonly owner_id: string; readonly snapshot_id: string },
  runs: Iterable<SerialisedEntryRun>,
  concurrency: number,
): Promise<ManifestPartReference[]> {
  const references: ManifestPartReference[] = [];
  const pool = new BoundedTaskPool(concurrency);
  for (const run of runs) {
    const identity: ManifestPartIdentity = {
      owner_field: layout.owner_field,
      ...snapshot,
      part_index: references.length,
    };
    const text = build_manifest_part_text(identity, run.entry_texts);
    references.push({ entry_count: run.entry_texts.length, digest: digest_part_text(ctx, text) });
    await pool.add(() => write_entry_part(ctx, layout, identity, text));
  }
  await pool.drain();
  return references;
}

/** Writes one entry part create-only and reads it back. */
async function write_entry_part(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  identity: ManifestPartIdentity,
  text: string,
): Promise<void> {
  await write_encrypted_json_text(
    ctx,
    {
      key: layout.keys.manifest_part_key(
        identity.owner_id,
        identity.snapshot_id,
        identity.part_index,
      ),
      label: `${layout.label} manifest part`,
      reader_check: (parsed, key) =>
        require_manifest_part_entries(
          parsed,
          layout.owner_field,
          layout.keys.manifest_part_key,
          key,
        ),
      write: 'create_only',
      confirm_read_back: true,
    },
    text,
  );
}

/** The head: every top-level field of the manifest, with `entry_parts` in place of `entries`. */
function build_manifest_head(
  manifest: DriveWritableManifest,
  parts: ManifestPartReference[],
): Record<string, unknown> {
  const { entries, ...head_fields } = manifest;
  const entry_parts: ManifestEntryParts = {
    version: MANIFEST_PARTS_VERSION,
    entry_count: entries.length,
    parts,
  };
  return { ...head_fields, entry_parts };
}

/** Writes a whole manifest or a head at the manifest key, create-only, and reads it back. */
async function write_manifest_document(
  ctx: TenantContext,
  layout: DriveManifestLayout,
  key: string,
  document: object,
): Promise<void> {
  await write_encrypted_json(
    ctx,
    {
      key,
      label: `${layout.label} manifest`,
      reader_check: (parsed, parsed_key) =>
        require_drive_manifest_document(layout, parsed, parsed_key),
      write: 'create_only',
      confirm_read_back: true,
    },
    document,
  );
}
