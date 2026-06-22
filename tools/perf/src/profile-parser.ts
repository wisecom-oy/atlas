import { readFile } from 'node:fs/promises';

import { classify_domain } from './domain-classifier.js';
import type {
  CpuProfile,
  CpuProfileNode,
  DomainStats,
  FunctionSummary,
  HotPath,
  HotPathFrame,
  ProfileEntry,
  ProfileReport,
} from './types.js';

interface NodeAccumulator {
  id: number;
  function_name: string;
  url: string;
  line_number: number;
  hit_count: number;
  self_time_us: number;
  total_time_us: number;
  domain: string;
  children_ids: number[];
}

/**
 * Parses a .cpuprofile file and produces a structured ProfileReport.
 * The report includes top functions by self-time, domain breakdown,
 * and hot paths through the call tree.
 */
export async function parse_profile(
  file_path: string,
  command_label: string,
): Promise<ProfileReport> {
  const raw = await readFile(file_path, 'utf-8');
  const profile: CpuProfile = JSON.parse(raw);

  const duration_us = profile.endTime - profile.startTime;
  const sample_count = profile.samples.length;
  const sample_interval_us = sample_count > 1 ? duration_us / sample_count : 1000;

  const node_map = build_node_map(profile.nodes, sample_interval_us);
  propagate_total_times(node_map, profile.nodes);

  const all_entries = collect_entries(node_map);
  const top_functions = extract_top_functions(all_entries, 30);
  const domain_breakdown = compute_domain_breakdown(all_entries);
  const hot_paths = extract_hot_paths(node_map, profile.nodes, duration_us, 8);

  return {
    command: command_label,
    duration_ms: duration_us / 1000,
    sample_count,
    sample_interval_us: Math.round(sample_interval_us),
    top_functions,
    domain_breakdown,
    hot_paths,
  };
}

function build_node_map(
  nodes: CpuProfileNode[],
  sample_interval_us: number,
): Map<number, NodeAccumulator> {
  const map = new Map<number, NodeAccumulator>();

  for (const node of nodes) {
    map.set(node.id, {
      id: node.id,
      function_name: node.callFrame.functionName || '(anonymous)',
      url: node.callFrame.url,
      line_number: node.callFrame.lineNumber + 1,
      hit_count: node.hitCount,
      self_time_us: node.hitCount * sample_interval_us,
      total_time_us: 0,
      domain: classify_domain(node.callFrame.url),
      children_ids: node.children ?? [],
    });
  }

  return map;
}

function propagate_total_times(
  node_map: Map<number, NodeAccumulator>,
  nodes: CpuProfileNode[],
): void {
  const root = nodes[0];
  if (!root) return;

  function compute_total(node_id: number): number {
    const node = node_map.get(node_id);
    if (!node) return 0;

    let total = node.self_time_us;
    for (const child_id of node.children_ids) {
      total += compute_total(child_id);
    }
    node.total_time_us = total;
    return total;
  }

  compute_total(root.id);
}

function collect_entries(node_map: Map<number, NodeAccumulator>): NodeAccumulator[] {
  return Array.from(node_map.values()).filter(
    (n) => n.function_name !== '(root)' && n.function_name !== '(program)',
  );
}

function extract_top_functions(entries: NodeAccumulator[], limit: number): FunctionSummary[] {
  return entries
    .filter((e) => e.self_time_us > 0)
    .sort((a, b) => b.self_time_us - a.self_time_us)
    .slice(0, limit)
    .map((e) => ({
      function_name: e.function_name,
      url: e.url,
      line_number: e.line_number,
      self_time_us: Math.round(e.self_time_us),
      total_time_us: Math.round(e.total_time_us),
    }));
}

function compute_domain_breakdown(entries: NodeAccumulator[]): DomainStats[] {
  const domain_map = new Map<
    string,
    { self: number; total: number; count: number; fns: NodeAccumulator[] }
  >();

  for (const entry of entries) {
    const existing = domain_map.get(entry.domain);
    if (existing) {
      existing.self += entry.self_time_us;
      existing.total += entry.total_time_us;
      existing.count += 1;
      existing.fns.push(entry);
    } else {
      domain_map.set(entry.domain, {
        self: entry.self_time_us,
        total: entry.total_time_us,
        count: 1,
        fns: [entry],
      });
    }
  }

  return Array.from(domain_map.entries())
    .map(([domain, stats]) => ({
      domain,
      self_time_us: Math.round(stats.self),
      total_time_us: Math.round(stats.total),
      function_count: stats.count,
      top_functions: stats.fns
        .sort((a, b) => b.self_time_us - a.self_time_us)
        .slice(0, 5)
        .map((e) => ({
          function_name: e.function_name,
          url: e.url,
          line_number: e.line_number,
          self_time_us: Math.round(e.self_time_us),
          total_time_us: Math.round(e.total_time_us),
        })),
    }))
    .sort((a, b) => b.self_time_us - a.self_time_us);
}

function extract_hot_paths(
  node_map: Map<number, NodeAccumulator>,
  nodes: CpuProfileNode[],
  total_duration_us: number,
  limit: number,
): HotPath[] {
  const root = nodes[0];
  if (!root) return [];

  const paths: HotPath[] = [];
  const visited_roots = new Set<number>();

  function walk_heaviest(start_id: number): HotPathFrame[] {
    const frames: HotPathFrame[] = [];
    let current_id: number | undefined = start_id;

    while (current_id !== undefined) {
      const node = node_map.get(current_id);
      if (!node) break;

      if (
        node.function_name !== '(root)' &&
        node.function_name !== '(program)' &&
        node.function_name !== '(idle)'
      ) {
        frames.push({
          function_name: node.function_name,
          domain: node.domain,
          self_time_us: Math.round(node.self_time_us),
        });
      }

      let heaviest_child: number | undefined;
      let heaviest_time = 0;
      for (const child_id of node.children_ids) {
        const child = node_map.get(child_id);
        if (child && child.total_time_us > heaviest_time) {
          heaviest_time = child.total_time_us;
          heaviest_child = child_id;
        }
      }

      current_id = heaviest_child;
    }

    return frames;
  }

  const root_node = node_map.get(root.id);
  if (!root_node) return [];

  const sorted_children = [...root_node.children_ids]
    .map((id) => node_map.get(id))
    .filter((n): n is NodeAccumulator => n !== undefined)
    .sort((a, b) => b.total_time_us - a.total_time_us);

  for (const child of sorted_children.slice(0, limit)) {
    if (visited_roots.has(child.id)) continue;
    visited_roots.add(child.id);

    const frames = walk_heaviest(child.id);
    if (frames.length === 0) continue;

    const path_time = child.total_time_us;
    paths.push({
      percentage: total_duration_us > 0 ? (path_time / total_duration_us) * 100 : 0,
      total_time_us: Math.round(path_time),
      frames,
    });
  }

  return paths.sort((a, b) => b.total_time_us - a.total_time_us).slice(0, limit);
}
