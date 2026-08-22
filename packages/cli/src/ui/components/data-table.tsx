import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

export interface TableColumn<Row> {
  key: keyof Row & string;
  header: string;
  /** Hard cap; longer cells are truncated with a trailing `~`. */
  max_width?: number;
  align?: 'left' | 'right';
  /** Ink color for a cell, decided per row. */
  color?: (row: Row) => string | undefined;
}

interface DataTableProps<Row> {
  columns: TableColumn<Row>[];
  rows: Row[];
}

function cell_text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

function fit(text: string, width: number, align: 'left' | 'right'): string {
  const truncated = text.length > width ? text.slice(0, width - 1) + '~' : text;
  return align === 'right' ? truncated.padStart(width) : truncated.padEnd(width);
}

const MIN_COLUMN_WIDTH = 8;

/**
 * Shrinks columns widest-first until the table (plus inter-column gaps) fits the terminal.
 * Columns never go below their header length or MIN_COLUMN_WIDTH, whichever is larger.
 */
function fit_widths_to_terminal(widths: number[], header_lengths: number[]): void {
  const gaps = 2 * Math.max(widths.length - 1, 0);
  const budget = (process.stdout.columns || 80) - gaps;
  let total = widths.reduce((sum, w) => sum + w, 0);
  while (total > budget) {
    let widest = -1;
    for (let i = 0; i < widths.length; i++) {
      const floor = Math.max(header_lengths[i] ?? 0, MIN_COLUMN_WIDTH);
      if (widths[i]! > floor && (widest === -1 || widths[i]! > widths[widest]!)) widest = i;
    }
    if (widest === -1) break;
    widths[widest]!--;
    total--;
  }
}

/** Column-aligned table with bold headers; replaces hand-padded console tables. */
export function DataTable<Row extends object>({
  columns,
  rows,
}: DataTableProps<Row>): ReactElement {
  const widths = columns.map((col) => {
    const content = rows.reduce(
      (max, row) => Math.max(max, cell_text(row[col.key]).length),
      col.header.length,
    );
    return Math.min(content, col.max_width ?? content);
  });
  fit_widths_to_terminal(
    widths,
    columns.map((col) => col.header.length),
  );

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        {columns.map((col, i) => (
          <Text key={col.key} bold>
            {fit(col.header, widths[i]!, col.align ?? 'left')}
          </Text>
        ))}
      </Box>
      <Box gap={2}>
        {columns.map((col, i) => (
          <Text key={col.key} dimColor>
            {'-'.repeat(widths[i]!)}
          </Text>
        ))}
      </Box>
      {rows.map((row, row_index) => (
        <Box key={row_index} gap={2}>
          {columns.map((col, i) => {
            const color = col.color?.(row);
            return (
              <Text key={col.key} {...(color === undefined ? {} : { color })}>
                {fit(cell_text(row[col.key]), widths[i]!, col.align ?? 'left')}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
