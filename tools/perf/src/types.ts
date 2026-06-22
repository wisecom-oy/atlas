/** Raw V8 CPU profile as written by --cpu-prof. */
export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export interface CpuProfileNode {
  id: number;
  callFrame: CallFrame;
  hitCount: number;
  children?: number[];
}

export interface CallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

/** Enriched node after tree construction and time computation. */
export interface ProfileEntry {
  id: number;
  function_name: string;
  url: string;
  line_number: number;
  self_time_us: number;
  total_time_us: number;
  hit_count: number;
  domain: string;
  children: ProfileEntry[];
}

/** Aggregated stats per Atlas domain. */
export interface DomainStats {
  domain: string;
  self_time_us: number;
  total_time_us: number;
  function_count: number;
  top_functions: FunctionSummary[];
}

export interface FunctionSummary {
  function_name: string;
  url: string;
  line_number: number;
  self_time_us: number;
  total_time_us: number;
}

/** A single critical path through the call tree. */
export interface HotPath {
  percentage: number;
  total_time_us: number;
  frames: HotPathFrame[];
}

export interface HotPathFrame {
  function_name: string;
  domain: string;
  self_time_us: number;
}

/** Complete analysis result ready for formatting. */
export interface ProfileReport {
  command: string;
  duration_ms: number;
  sample_count: number;
  sample_interval_us: number;
  top_functions: FunctionSummary[];
  domain_breakdown: DomainStats[];
  hot_paths: HotPath[];
}
