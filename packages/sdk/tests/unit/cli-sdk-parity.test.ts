/**
 * Strict parity guard: every application capability the CLI can reach must also be
 * reachable through the SDK. The CLI and the SDK are two adapters over the same ports,
 * so a capability wired into one and not the other is a wiring omission, not a design
 * choice. The SDK may expose more (that direction is allowed and asserted loosely).
 *
 * Known gaps are allowlisted with their issue number so this test fails on *new*
 * divergence instead of failing on the backlog.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const PORTS_DIR = join(REPO_ROOT, 'packages/types/src/ports');
const CLI_SRC = join(REPO_ROOT, 'packages/cli/src');
const SDK_SRC = join(REPO_ROOT, 'packages/sdk/src');

/** Port interfaces that carry application capability, as opposed to infrastructure. */
const APP_PORT_PATTERN = /UseCase$/;
const APP_PORT_EXTRAS: Record<string, true> = {
  TenantBackupOrchestrator: true,
  MailboxDiscoveryService: true,
  SharePointSiteConnector: true,
  UserIdentityResolver: true,
  IdentityRegistryRepository: true,
};

/** CLI-reachable capabilities the SDK cannot reach yet, each with its tracking issue. */
const KNOWN_METHOD_GAPS: Record<string, string> = {
  'TenantBackupOrchestrator.backup_tenant': '#165',
};

/** DI tokens the CLI resolves and the SDK does not. */
const KNOWN_TOKEN_GAPS: Record<string, string> = {
  // Retired with #166: the CLI tenant fan-out goes away, so this stops being a gap.
  TENANT_ORCHESTRATOR_TOKEN: '#165',
  // Intentional: the uncached inner resolver, used during rehydrate when the identity
  // cache lives in the bucket being recovered. The SDK takes owner ids directly.
  GRAPH_IDENTITY_RESOLVER_TOKEN: 'intentional',
  // Intentional: the encrypted local config store is a CLI concern. The SDK takes
  // tenant and credentials from AtlasInstanceConfig.
  ATLAS_CONFIG_TOKEN: 'intentional',
};

function collect_sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect_sources(full));
    else if (/\.tsx?$/.test(entry)) out.push(readFileSync(full, 'utf8'));
  }
  return out;
}

/** Maps every application port interface to the method names it declares. */
function read_app_port_methods(): Map<string, string[]> {
  const interface_pattern = /export interface (\w+)\s*(?:extends [^{]+)?\{([\s\S]*?)\n\}/g;
  const method_pattern = /^ {2}(?:readonly\s+)?(\w+)\s*(?:<[^>]*>)?\(/gm;
  const found = new Map<string, string[]>();

  for (const source of collect_sources(PORTS_DIR)) {
    for (const [, name, body] of source.matchAll(interface_pattern)) {
      if (!APP_PORT_PATTERN.test(name) && APP_PORT_EXTRAS[name] !== true) continue;
      const methods = [...body.matchAll(method_pattern)].map((m) => m[1] as string);
      if (methods.length > 0) found.set(name, methods);
    }
  }
  return found;
}

function is_called(sources: string[], method: string): boolean {
  const pattern = new RegExp(`\\.\\s*${method}\\s*\\(`);
  return sources.some((source) => pattern.test(source));
}

function resolved_tokens(sources: string[]): Set<string> {
  const found = new Set<string>();
  for (const source of sources) {
    for (const [, token] of source.matchAll(/container\.get<[^>]*>\(\s*([A-Z][A-Z0-9_]*_TOKEN)/g)) {
      found.add(token as string);
    }
  }
  return found;
}

describe('CLI/SDK capability parity', () => {
  const ports = read_app_port_methods();
  const cli = collect_sources(CLI_SRC);
  const sdk = collect_sources(SDK_SRC);

  it('finds the application ports to compare', () => {
    expect(ports.size).toBeGreaterThan(20);
    expect(ports.get('StatsUseCase')).toContain('get_onedrive_stats');
  });

  it('exposes every CLI-reachable port method through the SDK', () => {
    const gaps: string[] = [];
    for (const [port, methods] of ports) {
      for (const method of methods) {
        const key = `${port}.${method}`;
        if (KNOWN_METHOD_GAPS[key] !== undefined) continue;
        if (is_called(cli, method) && !is_called(sdk, method)) gaps.push(key);
      }
    }
    expect(gaps, 'CLI reaches these capabilities and the SDK cannot').toEqual([]);
  });

  it('resolves every CLI-resolved use-case token in the SDK', () => {
    const sdk_tokens = resolved_tokens(sdk);
    const cli_only = [...resolved_tokens(cli)].filter(
      (token) => !sdk_tokens.has(token) && KNOWN_TOKEN_GAPS[token] === undefined,
    );
    expect(cli_only, 'tokens the CLI resolves and the SDK never touches').toEqual([]);
  });

  it('keeps the allowlist honest: every listed gap is still a real gap', () => {
    const fixed: string[] = [];
    for (const key of Object.keys(KNOWN_METHOD_GAPS)) {
      const [port, method] = key.split('.') as [string, string];
      if (!ports.has(port)) {
        fixed.push(`${key} (port no longer exists)`);
        continue;
      }
      if (is_called(sdk, method)) fixed.push(`${key} (SDK reaches it now)`);
    }
    expect(fixed, 'remove these from KNOWN_METHOD_GAPS').toEqual([]);
  });
});
