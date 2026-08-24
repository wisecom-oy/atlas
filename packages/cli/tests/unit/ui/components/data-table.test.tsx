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

  it('shrinks the widest columns so the table fits the terminal width', () => {
    const original_columns = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    try {
      const wide: TableColumn<{ a: string; b: string }>[] = [
        { key: 'a', header: 'Site' },
        { key: 'b', header: 'Url' },
      ];
      const { lastFrame } = render(
        <DataTable
          columns={wide}
          rows={[{ a: 'x'.repeat(90), b: 'https://example.com/'.repeat(4) }]}
        />,
      );
      for (const line of lastFrame()!.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
      expect(lastFrame()).toContain('~');
    } finally {
      Object.defineProperty(process.stdout, 'columns', {
        value: original_columns,
        configurable: true,
      });
    }
  });

  // #175: at the 80-column fallback a site URL is cut to `https://contoso.sharepoint~`, which no
  // longer matches a hostname pattern, so anything scrubbing the output misses the tenant name.
  it('keeps a long cell intact when the width budget is wide', () => {
    const original_columns = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 4096, configurable: true });
    try {
      const wide: TableColumn<{ url: string }>[] = [{ key: 'url', header: 'Url' }];
      const url = 'https://contoso.sharepoint.com/sites/ExampleLongSiteName';
      const { lastFrame } = render(<DataTable columns={wide} rows={[{ url }]} />);

      expect(lastFrame()).toContain(url);
      expect(lastFrame()).not.toContain('~');
    } finally {
      Object.defineProperty(process.stdout, 'columns', {
        value: original_columns,
        configurable: true,
      });
    }
  });
});
