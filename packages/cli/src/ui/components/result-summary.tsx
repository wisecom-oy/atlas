import { Text } from 'ink';
import type { ReactElement } from 'react';
import { MUTED_COLOR } from '@/ui/theme';

export interface SummaryEntry {
  label: string;
  value: number | string;
  color?: string;
}

interface ResultSummaryProps {
  entries: SummaryEntry[];
  /** Trailing note, e.g. elapsed time. Rendered dim. */
  suffix?: string;
}

/** One-line colored counters row, e.g. `5 stored | 2 dedup | 0 errors -- 12s`. */
export function ResultSummary({ entries, suffix }: ResultSummaryProps): ReactElement {
  return (
    <Text>
      {entries.map((entry, i) => (
        <Text key={entry.label}>
          {i > 0 ? <Text color={MUTED_COLOR}> | </Text> : undefined}
          <Text {...(entry.color === undefined ? {} : { color: entry.color })} bold>
            {String(entry.value)}
          </Text>
          <Text> {entry.label}</Text>
        </Text>
      ))}
      {suffix === undefined ? undefined : <Text color={MUTED_COLOR}> — {suffix}</Text>}
    </Text>
  );
}
