export interface TeamsTeamStatus {
  readonly team_id: string;
  readonly team_display_name: string | undefined;
  readonly last_backup_at: Date | undefined;
  readonly last_snapshot_id: string | undefined;
  readonly total_channels: number;
}

export interface TeamsStatusUseCase {
  /** Reports the last backup run recorded for each team in the tenant, from the manifests. */
  check_teams_status(tenant_id: string): Promise<TeamsTeamStatus[]>;
}
