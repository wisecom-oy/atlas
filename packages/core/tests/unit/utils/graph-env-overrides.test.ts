import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { load_config, load_tenant_profile } from '@/utils/config';
import { find_overridden_fields } from '@/utils/graph-env-overrides';
import { logger } from '@/utils/logger';

vi.mock('node:fs');
vi.mock('node:os');
vi.mock('dotenv', () => ({ config: vi.fn() }));

const SHARED = {
  s3_endpoint: 'http://localhost:9000',
  s3_access_key: 'access',
  s3_secret_key: 'secret-key',
  encryption_passphrase: 'passphrase',
};
const PROD = { tenant_id: 'tid-prod', client_id: 'cid-prod', client_secret: 'secret-prod' };
const DR = { tenant_id: 'tid-dr', client_id: 'cid-dr', client_secret: 'secret-dr' };

/** Serves `contents` as ./atlas.config.json; the encrypted store is absent. */
function config_file(contents: object): void {
  vi.mocked(os.homedir).mockReturnValue('/home/testuser');
  vi.mocked(fs.existsSync).mockImplementation(
    (p) => String(p).includes('atlas.config.json') && !String(p).includes('.atlas'),
  );
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(contents));
}

function set_graph_env(graph: Partial<typeof PROD>): void {
  if (graph.tenant_id !== undefined) process.env['ATLAS_TENANT_ID'] = graph.tenant_id;
  if (graph.client_id !== undefined) process.env['ATLAS_CLIENT_ID'] = graph.client_id;
  if (graph.client_secret !== undefined) process.env['ATLAS_CLIENT_SECRET'] = graph.client_secret;
}

describe('ATLAS_* Graph variables over the selected profile', () => {
  const original_env = { ...process.env };
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...original_env };
    for (const key of Object.keys(process.env))
      if (key.startsWith('ATLAS_')) delete process.env[key];
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    config_file({ ...SHARED, tenants: { prod: PROD, dr: DR }, active_tenant: 'prod' });
  });

  afterEach(() => {
    process.env = original_env;
    warn.mockRestore();
  });

  it('warns once, naming the variables and the profile, when all three replace it', () => {
    set_graph_env(DR);

    expect(load_config()).toMatchObject(DR);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Environment variables override tenant profile "prod" for this run: ' +
        'ATLAS_TENANT_ID, ATLAS_CLIENT_ID, ATLAS_CLIENT_SECRET.',
    );
  });

  it('names the profile chosen with --profile', () => {
    set_graph_env(PROD);

    load_config({ profile: 'dr' });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tenant profile "dr"'));
  });

  it('never puts a variable value in the warning', () => {
    set_graph_env({ ...PROD, client_secret: 'env-only-secret' });

    load_config();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('env-only-secret');
    expect(String(warn.mock.calls[0]?.[0])).toContain('for this run: ATLAS_CLIENT_SECRET.');
  });

  it('stays silent when the variables match the profile', () => {
    set_graph_env(PROD);

    load_config();

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when the variables only fill fields the profile leaves empty', () => {
    config_file({ ...SHARED, tenants: { prod: { tenant_id: 'tid-prod', client_id: 'cid-prod' } } });
    set_graph_env({ client_secret: 'env-secret' });

    expect(load_config({ profile: 'prod' }).client_secret).toBe('env-secret');
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when all three variables run without a stored profile', () => {
    config_file(SHARED);
    set_graph_env(DR);

    expect(load_config()).toMatchObject(DR);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a partial override that changes the tenant ID', () => {
    set_graph_env({ tenant_id: 'tid-dr' });

    expect(() => load_config()).toThrow(
      'Environment variables change tenant profile "prod" (ATLAS_TENANT_ID) while others stay ' +
        'unset (ATLAS_CLIENT_ID, ATLAS_CLIENT_SECRET), so this run would combine two identities.',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a partial override that changes the client ID', () => {
    set_graph_env({ client_id: 'cid-dr', client_secret: 'secret-dr' });

    expect(() => load_config()).toThrow(
      '(ATLAS_CLIENT_ID, ATLAS_CLIENT_SECRET) while others stay unset (ATLAS_TENANT_ID)',
    );
  });

  it('accepts a partial override that only replaces the client secret, with a warning', () => {
    set_graph_env({ client_secret: 'rotated-secret' });

    expect(load_config()).toMatchObject({ tenant_id: 'tid-prod', client_secret: 'rotated-secret' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ATLAS_CLIENT_SECRET'));
  });

  it('accepts a partial override that repeats the profile tenant ID', () => {
    set_graph_env({ tenant_id: 'tid-prod' });

    expect(load_config().tenant_id).toBe('tid-prod');
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves --target-profile alone: load_tenant_profile neither applies nor checks them', () => {
    set_graph_env({ tenant_id: 'tid-other' });

    expect(load_tenant_profile('dr')).toEqual(DR);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('find_overridden_fields', () => {
  it('lists only fields both sides set to different values', () => {
    const saved = { a: '1', b: '2', c: '3' };
    const env = { a: '1', b: 'x', d: 'y' };

    expect(find_overridden_fields<string>(saved, env, ['a', 'b', 'c', 'd'])).toEqual(['b']);
  });
});
