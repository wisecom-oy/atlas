import {
  append_archive_entry,
  create_file_archive,
  finalize_file_archive,
  type ArchiveTarget,
  type FileArchive,
} from '@wisecom/atlas-core/services/shared/file-save-zip-writer';
import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';
import { mark_downloaded_from_internet } from '@wisecom/atlas-core/utils/zone-identifier';
import type {
  TeamsChannelIndexEntry,
  TeamsChannelShardRepository,
  TeamsSaveOptions,
  TeamsSaveResult,
  TeamsSnapshotIndex,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  team_document,
  channel_folder_name,
  type ExportedChannel,
} from '@/services/save/archive-layout';
import { export_channel } from '@/services/save/channel-export';
import type { ExportTally } from '@/services/save/thread-views';

/** Everything the archive writer needs for one export run. */
export interface ArchiveWriteRequest {
  readonly ctx: TenantContext;
  readonly shards: TeamsChannelShardRepository;
  readonly team_id: string;
  readonly index: TeamsSnapshotIndex;
  readonly channels: TeamsChannelIndexEntry[];
  readonly target: ArchiveTarget;
  /** The path the archive is published to; empty for a stream target. */
  readonly output_path: string;
  readonly options: TeamsSaveOptions;
}

/**
 * Writes the archive channel by channel, then `team.json`, and publishes it. A stopped run keeps
 * what was written: a path target is published as a partial archive, a stream target is aborted.
 */
export async function write_save_archive(request: ArchiveWriteRequest): Promise<TeamsSaveResult> {
  const { options, target, output_path, channels, index } = request;
  const file_archive = create_file_archive(target);
  const { archive, promise, publish, abort } = file_archive;
  try {
    const tally: ExportTally = { errors: [], images_inlined: 0, messages_saved: 0 };
    const { saved, processed } = await append_channels(request, file_archive, tally);
    emit_operation_progress(options, {
      operation: 'save',
      workload: 'teams',
      phase: 'finalizing',
      processed,
      total: channels.length,
    });
    await append_archive_entry(file_archive, 'team.json', Buffer.from(team_document(index, saved)));
    // Only channels left unvisited make the archive partial; a late Ctrl+C after the last channel does not.
    const interrupted = processed < channels.length;
    let total_bytes: number;
    if (interrupted && typeof target !== 'string') {
      total_bytes = archive.pointer();
      await abort();
    } else {
      await finalize_file_archive(archive);
      total_bytes = await promise;
      // Nothing appears at the output path until the archive is complete (see create_file_archive).
      await publish();
      // Only a path target has a local file to mark.
      if (output_path !== '') await mark_downloaded_from_internet(output_path);
    }
    emit_operation_progress(options, {
      operation: 'save',
      workload: 'teams',
      phase: interrupted ? 'interrupted' : 'completed',
      processed,
      total: channels.length,
    });
    return {
      snapshot_id: index.snapshot_id,
      channels_saved: saved.length,
      messages_saved: tally.messages_saved,
      images_inlined: tally.images_inlined,
      errors: tally.errors,
      output_path,
      total_bytes,
      interrupted,
    };
  } catch (err) {
    emit_operation_progress(options, {
      operation: 'save',
      workload: 'teams',
      phase: 'interrupted',
      processed: 0,
      total: channels.length,
    });
    await abort();
    throw err;
  }
}

/**
 * Exports each channel until the run is interrupted; returns the channels written and how many
 * were visited.
 */
async function append_channels(
  request: ArchiveWriteRequest,
  file_archive: FileArchive,
  tally: ExportTally,
): Promise<{ saved: ExportedChannel[]; processed: number }> {
  const { options, channels } = request;
  const saved: ExportedChannel[] = [];
  let processed = 0;
  emit_operation_progress(options, {
    operation: 'save',
    workload: 'teams',
    phase: 'processing',
    processed,
    total: channels.length,
  });
  for (const entry of channels) {
    if (options.should_interrupt?.() === true) break;
    const exported: ExportedChannel = {
      entry,
      folder: channel_folder_name(entry.channel_id, entry.display_name),
    };
    const files = await export_channel(
      request.ctx,
      request.shards,
      request.team_id,
      exported,
      tally,
    );
    for (const file of files ?? []) {
      await append_archive_entry(file_archive, file.path, Buffer.from(file.content, 'utf8'));
    }
    if (files !== undefined) saved.push(exported);
    processed++;
    emit_operation_progress(options, {
      operation: 'save',
      workload: 'teams',
      phase: 'processing',
      processed,
      total: channels.length,
      current: exported.folder,
    });
  }
  return { saved, processed };
}
