export interface TeamsTeamStatus {
  readonly team_id: string;
  readonly team_display_name: string | undefined;
  readonly last_backup_at: Date | undefined;
  readonly last_snapshot_id: string | undefined;
  readonly total_channels: number;
}

export interface TeamsStatusUseCase {
  /**
   * Reports the newest readable snapshot per team in the tenant. A team with no readable snapshot
   * is still listed, with undefined backup fields and zero channels.
   */
  check_teams_status(tenant_id: string): Promise<TeamsTeamStatus[]>;
}
