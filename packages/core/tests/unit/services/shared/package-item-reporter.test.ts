import { describe, it, expect } from 'vitest';
import {
  summarize_package_items,
  type PackageAwareDeltaItem,
} from '@/services/shared/package-item-reporter';

function notebook(name: string, parent_path = '/Docs'): PackageAwareDeltaItem {
  return {
    item_id: `nb-${name}`,
    file_name: name,
    parent_path,
    kind: 'folder',
    deleted: false,
    package_type: 'oneNote',
  };
}

function section(name: string, parent_path: string, item_id = `f-${name}`): PackageAwareDeltaItem {
  return { item_id, file_name: name, parent_path, kind: 'file', deleted: false };
}

const NO_FAILURES: ReadonlySet<string> = new Set();

describe('summarize_package_items', () => {
  it('reports nothing when the batch holds no package items', () => {
    const report = summarize_package_items(
      [section('report.pdf', '/Docs'), section('notes.txt', '/Docs')],
      NO_FAILURES,
    );

    expect(report).toEqual({ notebooks_detected: 0, section_files_backed_up: 0, warnings: [] });
  });

  it('counts a notebook and the section files stored beneath it', () => {
    const report = summarize_package_items(
      [
        notebook('Test'),
        section('Untitled Section.one', '/Docs/Test'),
        section('Open Notebook.onetoc2', '/Docs/Test'),
        section('unrelated.pdf', '/Docs'),
      ],
      NO_FAILURES,
    );

    expect(report.notebooks_detected).toBe(1);
    expect(report.section_files_backed_up).toBe(2);
    expect(report.warnings).toEqual([]);
  });

  it('counts section files nested deeper inside the notebook', () => {
    const report = summarize_package_items(
      [notebook('Test'), section('Deep.one', '/Docs/Test/Group')],
      NO_FAILURES,
    );

    expect(report.section_files_backed_up).toBe(1);
  });

  it('does not claim a sibling folder with a shared name prefix', () => {
    const report = summarize_package_items(
      [notebook('Test'), section('other.one', '/Docs/TestArchive')],
      NO_FAILURES,
    );

    expect(report.section_files_backed_up).toBe(0);
  });

  it('warns that a notebook is incomplete when one section fails', () => {
    const report = summarize_package_items(
      [
        notebook('Test'),
        section('Untitled Section.one', '/Docs/Test', 'bad'),
        section('Open Notebook.onetoc2', '/Docs/Test', 'good'),
      ],
      new Set(['bad']),
    );

    expect(report.section_files_backed_up).toBe(1);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('INCOMPLETE');
    expect(report.warnings[0]).toContain('Untitled Section.one');
    expect(report.warnings[0]).toContain('1 of 2');
  });

  it('keeps notebooks independent so one failure does not taint the others', () => {
    const report = summarize_package_items(
      [
        notebook('Broken'),
        section('a.one', '/Docs/Broken', 'bad'),
        notebook('Fine'),
        section('b.one', '/Docs/Fine', 'ok'),
      ],
      new Set(['bad']),
    );

    expect(report.notebooks_detected).toBe(2);
    expect(report.section_files_backed_up).toBe(1);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('Broken');
  });

  it('handles a notebook sitting at the drive root', () => {
    const report = summarize_package_items(
      [notebook('Test', '/'), section('a.one', '/Test')],
      NO_FAILURES,
    );

    expect(report.section_files_backed_up).toBe(1);
  });

  it('ignores a deleted notebook root', () => {
    const report = summarize_package_items(
      [{ ...notebook('Test'), deleted: true }, section('a.one', '/Docs/Test')],
      NO_FAILURES,
    );

    expect(report.notebooks_detected).toBe(0);
  });
});
