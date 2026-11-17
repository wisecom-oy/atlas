import { describe, expect, it } from 'vitest';
import { stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import { GraphOneDriveConnector } from '@/adapters/graph-onedrive-connector.adapter';

const DRIVE = 'drive-1';
const OWNER = 'owner-1';
const ROOT_DELTA = `/users/${OWNER}/drives/${DRIVE}/root/delta`;
/** A cursor written after `package` but before `shared` joined the selection. */
const PRE_SHARING_CURSOR = `https://graph.microsoft.com/v1.0/drives/${DRIVE}/root/delta?$select=id,package&token=t1`;
const PAGE_2 = `https://graph.microsoft.com/v1.0/drives/${DRIVE}/root/delta?token=p2`;
const NEXT_CURSOR = `https://graph.microsoft.com/v1.0/drives/${DRIVE}/root/delta?$select=id,package,shared&token=t2`;

describe('GraphOneDriveConnector delta and the #580 selection', () => {
  it('enumerates afresh for a pre-sharing cursor without reporting a reset', async () => {
    const { client, calls } = stub_graph_client(() => ({
      value: [],
      '@odata.deltaLink': NEXT_CURSOR,
    }));
    const connector = new GraphOneDriveConnector(client as never);

    const result = await connector.fetch_delta('tenant', OWNER, DRIVE, PRE_SHARING_CURSOR);

    expect(calls.map((call) => call.url)).toEqual([ROOT_DELTA]);
    expect(calls[0]?.select).toContain('shared');
    expect(result.reset_detected).toBe(false);
    expect(result.full_enumeration).toBe(true);
  });

  it('asks every delta page for hierarchical sharing', async () => {
    const { client, calls } = stub_graph_client(
      (call) =>
        call.url === ROOT_DELTA
          ? { value: [], '@odata.nextLink': PAGE_2 }
          : { value: [], '@odata.deltaLink': NEXT_CURSOR },
      { record_headers: true },
    );
    const connector = new GraphOneDriveConnector(client as never);

    await connector.fetch_delta('tenant', OWNER, DRIVE);

    expect(calls.map((call) => call.headers?.Prefer)).toEqual([
      'hierarchicalsharing',
      'hierarchicalsharing',
    ]);
  });
});
