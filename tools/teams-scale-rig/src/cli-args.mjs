/**
 * Command-line parsing for the Teams scale rig. Kept free of workspace imports so the selfcheck can load it.
 */

export const SCENARIO_NAMES = ['sync', 'kill-resume', 'throttle-isolation'];

const DEFAULTS = {
  teams: 100,
  channels_per_team: 10,
  time_scale: 1,
  seed: 586,
  concurrency: 4,
  parallel_teams: 5,
  store: null,
  json: false,
};

export const USAGE = `usage: teams-scale-rig <${SCENARIO_NAMES.join('|')}> [options]
  --teams N              teams in the fixture (default ${DEFAULTS.teams})
  --channels-per-team N  channels per team (default ${DEFAULTS.channels_per_team})
  --time-scale K         simulate Graph budgets K times faster (default ${DEFAULTS.time_scale})
  --seed S               fixture seed (default ${DEFAULTS.seed})
  --concurrency C        per-team channel concurrency, 1..16 (default ${DEFAULTS.concurrency})
  --parallel-teams N     teams backed up at once on this host, 1..64 (default ${DEFAULTS.parallel_teams})
  --store DIR            store root (default <tmp>/atlas-teams-rig-<seed>)
  --json                 also print the raw result as JSON`;

/**
 * Parses `<scenario> [--flag value ...]` into options. Throws on unknown flags or bad numbers.
 * @param {string[]} argv arguments after the script path
 */
export function parse_args(argv) {
  const [scenario, ...rest] = argv;
  if (!scenario || !SCENARIO_NAMES.includes(scenario))
    throw new Error(`unknown scenario: ${scenario ?? '(none)'}`);
  const opts = { ...DEFAULTS, scenario };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--json') {
      opts.json = true;
      continue;
    }
    const key = {
      '--teams': 'teams',
      '--channels-per-team': 'channels_per_team',
      '--time-scale': 'time_scale',
      '--seed': 'seed',
      '--concurrency': 'concurrency',
      '--parallel-teams': 'parallel_teams',
      '--store': 'store',
    }[flag];
    if (!key) throw new Error(`unknown option: ${flag}`);
    const value = rest[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    opts[key] = key === 'store' ? value : Number(value);
    if (key !== 'store' && !Number.isFinite(opts[key])) throw new Error(`${flag} must be a number`);
  }
  if (!(opts.time_scale > 0)) throw new Error('--time-scale must be > 0');
  if (!(opts.concurrency >= 1 && opts.concurrency <= 16))
    throw new Error('--concurrency must be 1..16');
  if (!Number.isInteger(opts.parallel_teams) || opts.parallel_teams < 1 || opts.parallel_teams > 64)
    throw new Error('--parallel-teams must be 1..64');
  return opts;
}
