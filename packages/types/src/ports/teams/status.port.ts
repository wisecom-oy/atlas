export interface TeamsTeamStatus {
  readonly team_id: string;
  readonly team_display_name: string | undefined;
  readonly last_backup_at: Date | undefined;
  readonly last_snapshot_id: string | undefined;
  readonly total_channels: number;
  /** Index and cursor keys that could not be read; the team's status may be older than its newest snapshot. */
  readonly unreadable_keys: string[];
  /**
   * The snapshot index keys among `unreadable_keys`. Each can be moved aside with `quarantine`
   * (issue #694). The rest are channel cursors, which the next backup rewrites.
   */
  readonly unreadable_index_keys: string[];
  /** Index and cursor keys written by a newer format version than this build reads. */
  readonly unsupported_keys: string[];
  /** Channel roots that failed in a previous run, summed over the team's channel cursors. */
  readonly failed_root_count: number;
  /** Hosted content roots still waiting for a recheck, summed over the team's channel cursors. */
  readonly pending_recheck_count: number;
}

export interface TeamsStatusUseCase {
  /**
   * Reports the newest readable snapshot per team in the tenant. A team with no readable snapshot
   * is still listed, with undefined backup fields and zero channels.
   */
  check_teams_status(tenant_id: string): Promise<TeamsTeamStatus[]>;
}
