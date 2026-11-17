/**
 * Plain-text tables for `outagesoft-365 profiles` and `outagesoft-365 faults`.
 */
import { FAULTS } from '../faults/fault-catalog.mjs';
import { SERVICE_SELECTORS } from '../request/m365-hosts.mjs';
import { PROFILES, total_rate } from '../planning/profiles.mjs';

/** Formats a probability as a percentage with sensible precision. */
function percent(rate) {
  const value = rate * 100;
  return `${value >= 1 ? Number(value.toFixed(1)) : Number(value.toFixed(2))}%`;
}

/** Formats a parameter spec: `5..30`, `90000`, `400|410`. */
function format_spec(spec) {
  if (Array.isArray(spec)) return `${spec[0]}..${spec[1]}`;
  if (spec && typeof spec === 'object') return spec.choice.join('|');
  return String(spec);
}

/** Names a fault's services by selector where one fits (`all`, `graph`), else lists them. */
function service_scope(services) {
  if (SERVICE_SELECTORS.all.every((s) => services.includes(s))) return 'all services';
  if (SERVICE_SELECTORS.graph.every((s) => services.includes(s))) return 'graph (all but identity)';
  return services.join('|');
}

/** Renders the profiles table: id, severity, total rate, summary, then each rate. */
export function render_profiles_table() {
  const lines = [];
  for (const profile of PROFILES) {
    lines.push(
      `${profile.id.padEnd(13)} severity ${profile.severity}  ~${percent(total_rate(profile.rates)).padEnd(6)} ${profile.summary}`,
    );
    const rates = Object.entries(profile.rates).sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < rates.length; i += 4) {
      const row = rates.slice(i, i + 4).map(([id, rate]) => `${id} ${percent(rate)}`);
      lines.push(`${' '.repeat(15)}${row.join(', ')}`);
    }
    for (const outage of profile.outages) {
      lines.push(
        `${' '.repeat(15)}outage: ${outage.service} from ${outage.start_ms / 1000}s for ${outage.duration_ms / 1000}s, ${outage.fault}`,
      );
    }
  }
  lines.push('');
  lines.push(
    'Rates are per eligible request; a fault only lands on requests it applies to (see: faults).',
  );
  lines.push('--intensity multiplies every rate; the total is clamped to 95 %.');
  return lines.join('\n');
}

/** Renders the fault catalog grouped by category, with applicability, parameters and basis. */
export function render_faults_table() {
  const lines = [];
  let category = null;
  const order = ['throttle', 'server', 'auth', 'consistency', 'transport', 'content', 'ordering'];
  const sorted = [...FAULTS].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  for (const fault of sorted) {
    if (fault.category !== category) {
      category = fault.category;
      lines.push('', category.toUpperCase());
    }
    const scope = [
      fault.forwards ? 'forwarded' : 'not forwarded',
      service_scope(fault.services),
      fault.kinds ? `kind ${fault.kinds.join('|')}` : null,
      fault.methods ? fault.methods.join('|') : null,
      fault.excluded_kinds ? `never kind ${fault.excluded_kinds.join('|')}` : null,
    ].filter(Boolean);
    const params = Object.entries(fault.params).map(
      ([name, spec]) => `${name}=${format_spec(spec)}`,
    );
    lines.push(`  ${fault.id}`);
    lines.push(`      ${fault.summary}`);
    lines.push(`      ${scope.join(', ')}${params.length ? `; ${params.join(' ')}` : ''}`);
    lines.push(`      basis: ${fault.basis}`);
  }
  return lines.join('\n').replace(/^\n/, '');
}
