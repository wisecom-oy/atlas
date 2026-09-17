/**
 * A user who has never opened OneDrive.
 *
 * Graph answers both drive lookups with 404 "User's mysite not found.". `list_drives` rethrew that
 * untouched, so consumers got a bare Graph error with no class and no code and retried a permanent
 * answer (issue #403), and `fallback_default_drive` reported it as a missing Graph grant, which
 * sent operators to Entra to grant permissions they already held (issue #404).
 *
 * A missing grant is a 403 and still has to report as one, so the precedence between the two is
 * part of the contract rather than an implementation detail.
 */

import { describe, it, expect, vi } from 'vitest';
import { Container } from 'inversify';
import { GRAPH_CLIENT_TOKEN, MissingGraphPermissionsError } from '@wisecom/atlas-m365-graph';
import { NotFoundError } from '@wisecom/atlas-types';
import { GraphOneDriveConnector } from '@/adapters/graph-onedrive-connector.adapter';

/** Graph rejections carry the status on the error object, which is what the mappers read. */
function graph_error(status: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: status });
}

function make_connector(responses: Record<string, () => Promise<unknown>>): GraphOneDriveConnector {
  const client = {
    api: vi.fn((path: string) => {
      const handler = responses[path];
      if (!handler) throw new Error(`unexpected Graph path: ${path}`);
      return { get: handler };
    }),
  };

  const container = new Container();
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(client);
  container.bind(GraphOneDriveConnector).toSelf();
  return container.get(GraphOneDriveConnector);
}

const DRIVES_PATH = '/users/owner-1/drives?$select=id,name';
const DEFAULT_DRIVE_PATH = '/users/owner-1/drive?$select=id,name';

describe('GraphOneDriveConnector.list_drives for an unprovisioned drive', () => {
  it('types a 404 from the drives collection as NotFoundError', async () => {
    const connector = make_connector({
      [DRIVES_PATH]: () => Promise.reject(graph_error(404, "User's mysite not found.")),
    });

    await expect(connector.list_drives('tenant-1', 'owner-1')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('carries the permanent Atlas code and says it is not a permissions problem', async () => {
    const connector = make_connector({
      [DRIVES_PATH]: () => Promise.reject(graph_error(404, "User's mysite not found.")),
    });

    const err = await connector.list_drives('tenant-1', 'owner-1').catch((e: unknown) => e);

    expect((err as NotFoundError).code).toBe('ATLAS_NOT_FOUND');
    expect((err as Error).message).toContain('owner-1');
    expect((err as Error).message).toContain('not a permissions problem');
    expect((err as Error).message).not.toContain('Files.Read.All');
  });

  it('types a 404 from the default-drive fallback as NotFoundError, not a missing grant', async () => {
    const connector = make_connector({
      [DRIVES_PATH]: () => Promise.resolve({ value: [] }),
      [DEFAULT_DRIVE_PATH]: () => Promise.reject(graph_error(404, "User's mysite not found.")),
    });

    await expect(connector.list_drives('tenant-1', 'owner-1')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('types a default drive with no id as NotFoundError', async () => {
    const connector = make_connector({
      [DRIVES_PATH]: () => Promise.resolve({ value: [] }),
      [DEFAULT_DRIVE_PATH]: () => Promise.resolve({ name: 'OneDrive' }),
    });

    await expect(connector.list_drives('tenant-1', 'owner-1')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('still reports a 403 as a missing Graph grant', async () => {
    const connector = make_connector({
      [DRIVES_PATH]: () => Promise.reject(graph_error(403, 'ErrorAccessDenied')),
    });

    await expect(connector.list_drives('tenant-1', 'owner-1')).rejects.toBeInstanceOf(
      MissingGraphPermissionsError,
    );
  });

  it('leaves a provisioned drive alone', async () => {
    const connector = make_connector({
      [DRIVES_PATH]: () => Promise.resolve({ value: [{ id: 'drive-1', name: 'OneDrive' }] }),
    });

    await expect(connector.list_drives('tenant-1', 'owner-1')).resolves.toEqual([
      { drive_id: 'drive-1', drive_name: 'OneDrive' },
    ]);
  });
});
