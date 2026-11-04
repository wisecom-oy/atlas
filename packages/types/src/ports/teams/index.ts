export type {
  TeamsConnector,
  TeamsMessageLocator,
  TeamsMessageDeltaResult,
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
export type {
  TeamsBackupUseCase,
  TeamsBackupSummary,
  TeamsBackupResult,
  TeamsBackupOptions,
  TeamsCatalogUseCase,
  TeamsVerificationUseCase,
  TeamsVerificationResult,
} from '@/ports/teams/use-case.port';
export type { TeamsDeletionUseCase } from '@/ports/teams/deletion.port';
export type { TeamsStatusUseCase, TeamsTeamStatus } from '@/ports/teams/status.port';
