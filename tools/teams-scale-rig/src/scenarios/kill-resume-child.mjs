/**
 * Child process for kill-resume: runs one backup pass against the parent's fake server, then
 * prints its wall time and memory peaks as one JSON line. SIGKILL from the parent stops it mid-run.
 * Usage: node kill-resume-child.mjs '<json config>'  (passphrase in ATLAS_TEAMS_RIG_PASSPHRASE)
 */
import { performance } from 'node:perf_hooks';
import { TENANT_ID } from '../fixture/generate-tenant.mjs';
import { open_session } from '../runner/rig-session.mjs';
import { backup_teams } from '../runner/backup-run.mjs';
import { start_process_sampler } from '../runner/process-sampler.mjs';

const config = JSON.parse(process.argv[2]);
const { container } = open_session({
  url: config.url,
  store_root: config.store_root,
  passphrase: process.env.ATLAS_TEAMS_RIG_PASSPHRASE,
  time_scale: config.time_scale,
});
const sampler = start_process_sampler();
const started = performance.now();
const results = await backup_teams({
  container,
  tenant_id: TENANT_ID,
  team_ids: config.team_ids,
  options: { concurrency: config.concurrency },
  parallel_teams: config.parallel_teams,
});
const wall_ms = performance.now() - started;
const channels = results.reduce((n, r) => n + r.summary.channels_scanned, 0);
const interrupted_teams = results.filter((r) => r.interrupted).length;
process.stdout.write(
  `${JSON.stringify({ wall_ms, channels, interrupted_teams, mem: sampler.stop() })}\n`,
);
process.exit(0);
