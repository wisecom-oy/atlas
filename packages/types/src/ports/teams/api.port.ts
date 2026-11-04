import type {
  TeamsBackupOptions,
  TeamsBackupResult,
  TeamsVerificationResult,
} from '@/ports/teams/use-case.port';
import type { TeamsTeamStatus } from '@/ports/teams/status.port';
import type { TeamsGraphResource, TeamsSnapshotIndex } from '@/domain/teams/manifest';
import type { TeamsSnapshotListing } from '@/ports/teams/index-repository.port';
import type { DeletionResult } from '@/ports/deletion/use-case.port';
import type { VerificationOptions } from '@/ports/verification/use-case.port';
import type { SdkOperationOptions } from '@/ports/atlas/progress-event.port';
import type { TeamsSaveOptions, TeamsSaveResult } from '@/ports/teams/save.port';
import type { Camelize } from '@/public/case-convert';

export type TeamsSdkBackupOptions = Camelize<
  Omit<TeamsBackupOptions, 'create_progress' | 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type TeamsSdkVerificationOptions = Camelize<
  Omit<VerificationOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type TeamsSdkBackupResult = Camelize<TeamsBackupResult>;
export type TeamsSdkVerificationResult = Camelize<TeamsVerificationResult>;
export type TeamsSdkSnapshotIndex = Camelize<TeamsSnapshotIndex>;
export type TeamsSdkSnapshotListing = Camelize<TeamsSnapshotListing>;
export type TeamsSdkTeamStatus = Camelize<TeamsTeamStatus>;
export type TeamsSdkDeletionResult = Camelize<DeletionResult>;
export type TeamsSdkSaveOptions = Camelize<
  Omit<TeamsSaveOptions, 'on_progress' | 'should_interrupt'>
> &
  SdkOperationOptions;
export type TeamsSdkSaveResult = Camelize<TeamsSaveResult>;

/** Teams as Graph returned them, unconverted: Graph's own camelCase fields are kept verbatim. */
export type TeamsSdkTeam = TeamsGraphResource;

/** Teams channel-message backup, one team per call. */
export interface TeamsApi {
  /** Backs up one team's channel messages. `channelId` in options limits the run to one channel. */
  backup(teamId: string, options?: TeamsSdkBackupOptions): Promise<TeamsSdkBackupResult>;
  verify(
    teamId: string,
    snapshotId: string,
    options?: TeamsSdkVerificationOptions,
  ): Promise<TeamsSdkVerificationResult>;
  /** Lists the teams in the tenant as Graph reports them. */
  listTeams(): Promise<TeamsSdkTeam[]>;
  /** Lists a team's snapshots; `unreadableKeys` names manifests that could not be read. */
  listSnapshots(teamId: string): Promise<TeamsSdkSnapshotListing>;
  /** Reports the last backup run recorded for each team in the tenant. */
  status(): Promise<TeamsSdkTeamStatus[]>;
  /** Deletes all backed-up data for a team, or only `snapshotId` when it is given. */
  delete(teamId: string, snapshotId?: string): Promise<TeamsSdkDeletionResult>;
  /** Exports one snapshot as a zip: team.json, per-channel messages.json, and HTML transcripts. */
  save(teamId: string, options: TeamsSdkSaveOptions): Promise<TeamsSdkSaveResult>;
}
