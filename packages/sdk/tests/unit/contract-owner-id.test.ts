import { describe, expect, it } from 'vitest';
import {
  normalize_owner_id,
  parse_team_id,
} from '@wisecom/atlas-core/services/shared/identifier-normalization';
import * as contract from '@/contract';
import * as sdk from '@/index';

const SITE_GUID = 'AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB';
const WEB_GUID = 'CCCCCCCC-4444-5555-6666-DDDDDDDDDDDD';
const TEAM = '00000000-0000-0000-0000-00000000000a';

describe('contract normalizeOwnerId', () => {
  it('lowercases a mixed-case object ID the way the workload services key it', () => {
    expect(contract.normalizeOwnerId('0000000A-0000-0000-0000-00000000000B')).toBe(
      '0000000a-0000-0000-0000-00000000000b',
    );
  });

  it('keys a Graph site the way SharePoint backup does once composed with canonicalSiteId', () => {
    const graph_id = `Contoso.SharePoint.com,${SITE_GUID},${WEB_GUID}`;
    expect(contract.normalizeOwnerId(contract.canonicalSiteId(graph_id))).toBe(
      `${SITE_GUID},${WEB_GUID}`.toLowerCase(),
    );
  });

  it('leaves canonicalSiteId case-preserving on its own', () => {
    const graph_id = `contoso.sharepoint.com,${SITE_GUID},${WEB_GUID}`;
    expect(contract.canonicalSiteId(graph_id)).toBe(`${SITE_GUID},${WEB_GUID}`);
  });
});

describe('contract parseTeamId', () => {
  it('trims and lowercases a Teams GUID', () => {
    expect(contract.parseTeamId(`\t ${TEAM.toUpperCase()} \n`)).toBe(TEAM);
  });

  it.each(['', 'team-1', `${TEAM}0`, `{${TEAM}}`, `https://teams.example.com/${TEAM}`])(
    'rejects %j',
    (value) => {
      expect(contract.parseTeamId(value)).toBeUndefined();
    },
  );
});

describe('one implementation', () => {
  it('publishes the bindings the workload services call', () => {
    expect(contract.normalizeOwnerId).toBe(normalize_owner_id);
    expect(contract.parseTeamId).toBe(parse_team_id);
  });

  it('re-exports the same bindings from the main entry', () => {
    expect(sdk.normalizeOwnerId).toBe(contract.normalizeOwnerId);
    expect(sdk.parseTeamId).toBe(contract.parseTeamId);
  });
});
