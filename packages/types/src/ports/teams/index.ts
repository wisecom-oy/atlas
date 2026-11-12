export type {
  TeamsConnector,
  TeamsMessageLocator,
  TeamsMessageDeltaPage,
  TeamsMessageListPage,
  TeamsRootChange,
  TeamsRootFetchResult,
  TeamsHostedContent,
} from '@/ports/teams/connector.port';
export type {
  TeamsIndexRepository,
  TeamsLatestIndex,
  TeamsSnapshotListing,
  TeamsTeamListing,
} from '@/ports/teams/index-repository.port';
export type { TeamsChannelShardRepository } from '@/ports/teams/channel-shard-repository.port';
export type {
  TeamsChannelCursorRepository,
  TeamsCursorScan,
} from '@/ports/teams/channel-cursor-repository.port';
export type { TeamsChannelCheckpointRepository } from '@/ports/teams/channel-checkpoint-repository.port';
export type {
  TeamsBackupUseCase,
  TeamsBackupSummary,
  TeamsBackupResult,
  TeamsBackupOptions,
  TeamsCatalogUseCase,
  TeamsVerificationUseCase,
  TeamsVerificationResult,
  TeamsChannelRunOutcome,
  TeamsChannelRunReport,
  TeamsRequestClassReport,
  TeamsRequestReport,
} from '@/ports/teams/use-case.port';
export type { TeamsDeletionUseCase } from '@/ports/teams/deletion.port';
export type { TeamsStatusUseCase, TeamsTeamStatus } from '@/ports/teams/status.port';
export type { TeamsSaveUseCase, TeamsSaveOptions, TeamsSaveResult } from '@/ports/teams/save.port';
export type {
  TeamsApi,
  TeamsSdkBackupOptions,
  TeamsSdkBackupResult,
  TeamsSdkVerificationOptions,
  TeamsSdkVerificationResult,
  TeamsSdkSnapshotIndex,
  TeamsSdkSnapshotListing,
  TeamsSdkTeamStatus,
  TeamsSdkTeam,
  TeamsSdkDeletionResult,
} from './api.port';
