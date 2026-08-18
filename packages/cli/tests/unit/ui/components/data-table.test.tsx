import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { DataTable } from '@/ui/components/data-table';
import type { TableColumn } from '@/ui/components/data-table';

interface Row {
  name: string;
  count: number;
}

const columns: TableColumn<Row>[] = [
  { key: 'name', header: 'Folder', max_width: 10 },
  { key: 'count', header: 'Items', align: 'right' },
];

describe('DataTable', () => {
  it('renders headers, separator, and rows', () => {
    const { lastFrame } = render(
      <DataTable columns={columns} rows={[{ name: 'Inbox', count: 42 }]} />,
    );
    const lines = lastFrame()!.split('\n');
    expect(lines[0]).toContain('Folder');
    expect(lines[0]).toContain('Items');
    expect(lines[1]).toMatch(/^-+\s+-+/);
    expect(lines[2]).toContain('Inbox');
    expect(lines[2]).toContain('42');
  });

  it('truncates cells beyond max_width with a tilde', () => {
    const { lastFrame } = render(
      <DataTable columns={columns} rows={[{ name: 'Conversation History', count: 1 }]} />,
    );
    expect(lastFrame()).toContain('Conversat~');
    expect(lastFrame()).not.toContain('Conversation History');
  });

  it('right-aligns numeric columns', () => {
    const { lastFrame } = render(
      <DataTable
        columns={columns}
        rows={[
          { name: 'A', count: 1 },
          { name: 'B', count: 12345 },
        ]}
      />,
    );
    const lines = lastFrame()!.split('\n');
    expect(lines[2]!.endsWith('    1')).toBe(true);
    expect(lines[3]!.endsWith('12345')).toBe(true);
  });
});
