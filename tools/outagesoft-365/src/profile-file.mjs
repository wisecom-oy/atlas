/**
 * Loading and validating a custom profile from `--profile-file`.
 *
 * Same shape as the built-ins. Unknown keys and unknown fault ids are errors,
 * not warnings: a misspelt `throtle_429` would otherwise run a clean baseline
 * while the operator believes they are testing throttling.
 */
import { readFileSync } from 'node:fs';
import { get_fault, validate_param_override } from './fault-catalog.mjs';
import { validate_outage } from './outage-schedule.mjs';

const PROFILE_KEYS = new Set(['id', 'summary', 'severity', 'rates', 'params', 'outages']);

/** Throws unless every rate names a known fault and lies in [0, 1]. */
function validate_rates(rates) {
  if (!rates || typeof rates !== 'object' || Array.isArray(rates))
    throw new Error('"rates" must be an object');
  for (const [id, rate] of Object.entries(rates)) {
    if (!get_fault(id)) throw new Error(`unknown fault '${id}' in rates`);
    if (typeof rate !== 'number' || !(rate >= 0 && rate <= 1)) {
      throw new Error(
        `rate for '${id}' must be a number from 0 to 1 (got ${JSON.stringify(rate)})`,
      );
    }
  }
}

/** Throws unless every override names a known fault and one of its parameters. */
function validate_params(params) {
  if (typeof params !== 'object' || params === null || Array.isArray(params))
    throw new Error('"params" must be an object');
  for (const [id, overrides] of Object.entries(params)) {
    const fault = get_fault(id);
    if (!fault) throw new Error(`unknown fault '${id}' in params`);
    if (typeof overrides !== 'object' || overrides === null)
      throw new Error(`params for '${id}' must be an object`);
    for (const [name, spec] of Object.entries(overrides))
      validate_param_override(fault, name, spec);
  }
}

/** Validates a parsed profile object and returns it with defaults filled in. */
export function validate_profile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile))
    throw new Error('a profile must be a JSON object');
  const unknown = Object.keys(profile).find((key) => !PROFILE_KEYS.has(key));
  if (unknown) throw new Error(`unknown profile key '${unknown}'`);
  if (typeof profile.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(profile.id)) {
    throw new Error('"id" must be a short lowercase name');
  }
  if (!Number.isInteger(profile.severity) || profile.severity < 0 || profile.severity > 5) {
    throw new Error('"severity" must be an integer from 0 to 5');
  }
  validate_rates(profile.rates);
  validate_params(profile.params ?? {});
  const outages = profile.outages ?? [];
  if (!Array.isArray(outages)) throw new Error('"outages" must be an array');
  outages.forEach(validate_outage);
  return { summary: '', ...profile, params: profile.params ?? {}, outages };
}

/** Reads and validates a profile file, naming the file in any error. */
export function load_profile_file(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `--profile-file '${path}': ${error.code === 'ENOENT' ? 'no such file' : error.message}`,
    );
  }
  try {
    return validate_profile(parsed);
  } catch (error) {
    throw new Error(`--profile-file '${path}': ${error.message}`);
  }
}
