import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@wisecom/atlas-core';
import { render_static_view } from '@/ui/render';
import { report_drive_restore, type DriveRestoreSummary } from '@/commands/drive/restore-presenter';
import { report_permission_listing } from '@/commands/drive/permission-list-presenter';

vi.mock('@/ui/render', () => ({ render_static_view: vi.fn(async () => undefined) }));

interface Props {
  readonly children?: ReactElement<Props> | ReactElement<Props>[];
  readonly items?: { label: string; value: string }[];
  readonly rows?: Record<string, string>[];
}

/** Every prop object in a rendered element tree, depth first. */
function props_in(element: ReactElement<Props>): Props[] {
  const children = element.props.children;
  const nested = children === undefined ? [] : Array.isArray(children) ? children : [children];
  return [element.props, ...nested.flatMap((child) => props_in(child))];
}

function rendered_props(): Props[] {
  return vi
    .mocked(render_static_view)
    .mock.calls.flatMap(([element]) => props_in(element as ReactElement<Props>));
}

function summary(overrides: Partial<DriveRestoreSummary> = {}): DriveRestoreSummary {
  return {
    snapshot_id: 'snap-1',
    files_restored: 2,
    folders_created: 1,
    files_skipped: 0,
    errors: [],
    interrupted: false,
    ...overrides,
  };
}

beforeEach(() => {
  process.exitCode = undefined;
  vi.mocked(render_static_view).mockClear();
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'success').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('drive restore summary for folder colours (#581)', () => {
  it('shows the colours left out and still exits 0 with success', async () => {
    await report_drive_restore('Restore', summary({ folder_colors_not_restored: 3 }), []);

    const items = rendered_props().flatMap((props) => props.items ?? []);
    expect(items).toContainEqual({
      label: 'Folder colours not restored',
      value: '3 (not supported by Microsoft Graph, see docs)',
    });
    expect(process.exitCode).toBeUndefined();
    expect(logger.success).toHaveBeenCalled();
  });

  it('shows no colour row when the restore met no coloured folder', async () => {
    await report_drive_restore('Restore', summary(), []);

    const labels = rendered_props().flatMap((props) => (props.items ?? []).map((i) => i.label));
    expect(labels).not.toContain('Folder colours not restored');
  });
});

describe('list-permissions with folder colours (#581)', () => {
  it('prints a colour table after the permissions', async () => {
    await report_permission_listing('Permissions', {
      snapshot_id: 'snap-1',
      items: [],
      folder_colors: [
        { file_id: 'a', drive_id: 'd', path: '/Projects', folder_color: { color_hex: '6' } },
        {
          file_id: 'b',
          drive_id: 'd',
          path: '/Archive',
          folder_color: { color_hex: '2', color_tag: 'Red', emoji: 'star' },
        },
      ],
    });

    const rows = rendered_props().flatMap((props) => props.rows ?? []);
    expect(rows).toEqual([
      { path: '/Projects', color: 'palette 6' },
      { path: '/Archive', color: 'palette 2, tag Red, emoji star' },
    ]);
  });

  it('prints no colour table when no folder is coloured', async () => {
    await report_permission_listing('Permissions', {
      snapshot_id: 'snap-1',
      items: [],
      folder_colors: [],
    });

    expect(rendered_props().flatMap((props) => props.rows ?? [])).toEqual([]);
  });
});
