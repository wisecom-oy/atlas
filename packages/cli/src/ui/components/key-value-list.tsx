import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { ACCENT_COLOR } from '@/ui/theme';

export interface KeyValueItem {
  label: string;
  value: string;
  /** Ink color for the value; defaults to the accent color. */
  color?: string;
}

interface KeyValueListProps {
  items: KeyValueItem[];
}

/** Aligned label/value block used for command headers and result details. */
export function KeyValueList({ items }: KeyValueListProps): ReactElement {
  const label_width = items.reduce((max, item) => Math.max(max, item.label.length), 0) + 1;

  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <Box key={item.label}>
          <Text>{`${item.label}:`.padEnd(label_width + 1)}</Text>
          <Text color={item.color ?? ACCENT_COLOR}>{item.value}</Text>
        </Box>
      ))}
    </Box>
  );
}
