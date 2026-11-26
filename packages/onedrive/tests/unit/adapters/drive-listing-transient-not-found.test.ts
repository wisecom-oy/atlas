/**
 * A 404 on the drive listing that is not Graph's "no OneDrive" answer (issue #863).
 *
 * Every 404 on `GET /users/{id}/drives` used to become the not-provisioned `NotFoundError` and exit
 * `7`, so one transient `itemNotFound` stopped a scheduler from backing up an owner who has a
 * OneDrive. Only `404 ResourceNotFound` "User's mysite not found." is that answer now; any other
 * 404 is read again, and one that persists for an owner who exists is `GraphUnavailableError`,
 * exit `3`. The SDK sees the same two error classes.
 */

import 'reflect-metadata';
import type { Client } from '@microsoft/microsoft-graph-client';
import { Container } from 'inversify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRAPH_CLIENT_TOKEN, MissingGraphPermissionsError } from '@wisecom/atlas-m365-graph';
import { GraphUnavailableError, NotFoundError } from '@wisecom/atlas-types';
import {
  graph_error,
  stub_graph_client,
  type GraphCall,
} from '@wisecom/atlas-types/testing/stub-graph-client';
import { GraphOneDriveConnector } from '@/adapters/graph-onedrive-connector.adapter';

const OWNER = 'owner-1';
const DRIVES = `/users/${OWNER}/drives?$select=id,name`;
const DEFAULT_DRIVE = `/users/${OWNER}/drive?$select=id,name`;
const USER = `/users/${OWNER}?$select=id`;
const DRIVE_LIST = { value: [{ id: 'drive-1', name: 'OneDrive' }] };

/** A connector over a stub client that answers each url's nth call through `route`. */
function connector_for(route: (url: string, count: number) => unknown) {
  const counts = new Map<string, number>();
  const graph = stub_graph_client((call: GraphCall) => {
    const count = (counts.get(call.url) ?? 0) + 1;
    counts.set(call.url, count);
    return route(call.url, count);
  });
  const container = new Container();
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(graph.client as unknown as Client);
  container.bind(GraphOneDriveConnector).toSelf();
  const urls = (): string[] => graph.calls.map((call) => call.url);
  return { connector: container.get(GraphOneDriveConnector), urls };
}

/** Lists the owner's drives, advancing fake time through the confirmation waits. */
async function list_drives(connector: GraphOneDriveConnector): Promise<unknown> {
  const outcome = connector.list_drives('tenant-1', OWNER).catch((error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GraphOneDriveConnector.list_drives after a 404 that is not the mysite answer', () => {
  it('lists the drives when one itemNotFound clears on the next read', async () => {
    const { connector, urls } = connector_for((_url, count) => {
      if (count === 1) throw graph_error(404, 'itemNotFound');
      return DRIVE_LIST;
    });

    await expect(list_drives(connector)).resolves.toEqual([
      { drive_id: 'drive-1', drive_name: 'OneDrive' },
    ]);
    expect(urls()).toEqual([DRIVES, DRIVES]);
  });

  it('lists the default drive when one 404 on it clears on the next read', async () => {
    const { connector } = connector_for((url, count) => {
      if (url === DRIVES) return { value: [] };
      if (count === 1) throw graph_error(404, 'itemNotFound');
      return { id: 'drive-1', name: 'OneDrive' };
    });

    await expect(list_drives(connector)).resolves.toEqual([
      { drive_id: 'drive-1', drive_name: 'OneDrive' },
    ]);
  });

  it('reports a 404 that persists for an owner who exists as GraphUnavailableError', async () => {
    const { connector } = connector_for((url) => {
      if (url === USER) return { id: OWNER };
      throw graph_error(404, 'itemNotFound');
    });

    const { error } = (await list_drives(connector)) as { error: unknown };

    expect(error).toBeInstanceOf(GraphUnavailableError);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({
      code: 'ATLAS_GRAPH_UNAVAILABLE',
      status_code: 404,
      graph_code: 'itemNotFound',
    });
  });

  it('reports NotFoundError when the owner is gone from the directory too', async () => {
    const { connector, urls } = connector_for(() => {
      throw graph_error(404, 'itemNotFound');
    });

    const { error } = (await list_drives(connector)) as { error: unknown };

    expect(error).toBeInstanceOf(NotFoundError);
    expect(urls()).toHaveLength(6);
  });

  it('accepts the mysite answer on the first read, with no confirming request', async () => {
    const { connector, urls } = connector_for(() => {
      throw graph_error(404, 'ResourceNotFound', "User's mysite not found.");
    });

    const { error } = (await list_drives(connector)) as { error: unknown };

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as Error).message).toContain('No OneDrive is provisioned');
    expect(urls()).toEqual([DRIVES]);
  });

  it('still reports a 403 on the listing as a missing grant, on the first read', async () => {
    const { connector, urls } = connector_for(() => {
      throw graph_error(403, 'accessDenied');
    });

    const { error } = (await list_drives(connector)) as { error: unknown };

    expect(error).toBeInstanceOf(MissingGraphPermissionsError);
    expect(urls()).toEqual([DRIVES]);
  });

  it('never asks for the default drive or the user when the listing has a drive', async () => {
    const { connector, urls } = connector_for(() => DRIVE_LIST);

    await list_drives(connector);

    expect(urls()).not.toContain(DEFAULT_DRIVE);
    expect(urls()).not.toContain(USER);
  });
});
