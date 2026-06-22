import type { DomainStats, FunctionSummary, HotPath, ProfileReport } from './types.js';

/**
 * Formats a ProfileReport into a structured plain-text string
 * optimized for LLM consumption and human readability.
 */
export function format_report(report: ProfileReport): string {
  const sections: string[] = [
    format_header(report),
    format_top_functions(report.top_functions, report.duration_ms),
    format_domain_breakdown(report.domain_breakdown, report.duration_ms),
    format_hot_paths(report.hot_paths),
    format_observations(report.domain_breakdown, report.duration_ms),
  ];

  return sections.join('\n');
}

function format_header(report: ProfileReport): string {
  return [
    '=== ATLAS PERFORMANCE PROFILE ===',
    `Command: ${report.command}`,
    `Duration: ${format_duration(report.duration_ms)} | Samples: ${report.sample_count.toLocaleString()} | Sample interval: ${report.sample_interval_us}μs`,
    '',
  ].join('\n');
}

function format_top_functions(functions: FunctionSummary[], total_ms: number): string {
  const total_us = total_ms * 1000;
  const lines: string[] = ['--- TOP FUNCTIONS BY SELF-TIME ---'];
  lines.push(pad_row('#', 'Self ms', 'Self %', 'Total ms', 'Function', 'Location'));
  lines.push('-'.repeat(110));

  for (let i = 0; i < Math.min(functions.length, 20); i++) {
    const fn = functions[i]!;
    const self_ms = (fn.self_time_us / 1000).toFixed(1);
    const self_pct = total_us > 0 ? ((fn.self_time_us / total_us) * 100).toFixed(1) + '%' : '-';
    const total_fn_ms = (fn.total_time_us / 1000).toFixed(1);
    const location = shorten_url(fn.url, fn.line_number);

    lines.push(
      pad_row(
        String(i + 1),
        self_ms,
        self_pct,
        total_fn_ms,
        truncate(fn.function_name, 35),
        location,
      ),
    );
  }

  lines.push('');
  return lines.join('\n');
}

function format_domain_breakdown(domains: DomainStats[], total_ms: number): string {
  const total_us = total_ms * 1000;
  const lines: string[] = ['--- DOMAIN BREAKDOWN ---'];
  lines.push(pad_domain_row('Domain', 'Self ms', 'Self %', 'Functions', 'Top contributor'));
  lines.push('-'.repeat(100));

  for (const domain of domains) {
    if (domain.self_time_us === 0) continue;

    const self_ms = (domain.self_time_us / 1000).toFixed(1);
    const self_pct = total_us > 0 ? ((domain.self_time_us / total_us) * 100).toFixed(1) + '%' : '-';
    const top_fn = domain.top_functions[0]?.function_name ?? '-';

    lines.push(
      pad_domain_row(
        truncate(domain.domain, 22),
        self_ms,
        self_pct,
        String(domain.function_count),
        truncate(top_fn, 30),
      ),
    );
  }

  lines.push('');
  return lines.join('\n');
}

function format_hot_paths(paths: HotPath[]): string {
  const lines: string[] = ['--- HOT PATHS (critical call chains) ---'];

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    const time_str = (path.total_time_us / 1000).toFixed(1);
    lines.push(`\n${i + 1}. [${path.percentage.toFixed(1)}% | ${time_str}ms]`);

    for (let depth = 0; depth < path.frames.length; depth++) {
      const frame = path.frames[depth]!;
      const indent = '  '.repeat(depth + 1);
      const self_note =
        frame.self_time_us > 0 ? ` (self: ${(frame.self_time_us / 1000).toFixed(1)}ms)` : '';
      lines.push(`${indent}-> ${frame.function_name} [${frame.domain}]${self_note}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function format_observations(domains: DomainStats[], total_ms: number): string {
  const total_us = total_ms * 1000;
  const lines: string[] = ['--- OBSERVATIONS ---'];

  const crypto_domains = domains.filter(
    (d) => d.domain === 'node:crypto' || d.domain === '@wisecom/atlas-core/crypto',
  );
  const crypto_self = crypto_domains.reduce((sum, d) => sum + d.self_time_us, 0);
  if (crypto_self > 0) {
    const pct = ((crypto_self / total_us) * 100).toFixed(1);
    lines.push(`- Encryption/crypto accounts for ${pct}% of CPU self-time`);
  }

  const s3_domain = domains.find((d) => d.domain === '@wisecom/atlas-s3');
  if (s3_domain && s3_domain.self_time_us > 0) {
    const pct = ((s3_domain.self_time_us / total_us) * 100).toFixed(1);
    lines.push(`- S3 storage operations account for ${pct}% of CPU self-time`);
  }

  const graph_domain = domains.find((d) => d.domain === '@wisecom/atlas-m365-graph');
  if (graph_domain && graph_domain.self_time_us > 0) {
    const pct = ((graph_domain.self_time_us / total_us) * 100).toFixed(1);
    lines.push(`- Graph API client accounts for ${pct}% of CPU self-time`);
  }

  const network_domain = domains.find((d) => d.domain === 'node:network');
  if (network_domain && network_domain.self_time_us > 0) {
    const pct = ((network_domain.self_time_us / total_us) * 100).toFixed(1);
    lines.push(
      `- Network/TLS internals account for ${pct}% (I/O wait not captured in CPU profile)`,
    );
  }

  lines.push('');
  lines.push('NOTE: CPU profiles capture compute time only. Network I/O latency (Graph API');
  lines.push('round-trips, S3 upload waits) appears as idle time and is NOT reflected above.');
  lines.push('For I/O bottleneck analysis, supplement with wall-clock tracing.');
  lines.push('');

  return lines.join('\n');
}

function format_duration(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}min`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms.toFixed(0)}ms`;
}

function shorten_url(url: string, line: number): string {
  if (!url) return '(native)';
  const match = url.match(/packages\/(.+)/);
  const short = match ? match[1] : url.replace(/.*\//, '');
  return `${short}:${line}`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function pad_row(
  idx: string,
  self_ms: string,
  self_pct: string,
  total_ms: string,
  fn_name: string,
  location: string,
): string {
  return [
    idx.padStart(3),
    self_ms.padStart(9),
    self_pct.padStart(8),
    total_ms.padStart(10),
    '  ' + fn_name.padEnd(37),
    location,
  ].join('');
}

function pad_domain_row(
  domain: string,
  self_ms: string,
  self_pct: string,
  fn_count: string,
  top_fn: string,
): string {
  return [
    domain.padEnd(24),
    self_ms.padStart(9),
    self_pct.padStart(8),
    fn_count.padStart(11),
    '  ' + top_fn,
  ].join('');
}
