import 'reflect-metadata';
import { Container } from 'inversify';
import {
  type AtlasConfig,
  type GraphConfig,
  type LoadConfigOptions,
  load_config,
  load_tenant_profile,
  ATLAS_CONFIG_TOKEN,
  CachingIdentityResolver,
} from '@wisecom/atlas-core';
import { bind_core_services } from '@wisecom/atlas-core';
import { ConfigError, USER_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-types';
import { bind_graph_client } from '@wisecom/atlas-m365-graph';
import { bind_s3_storage } from '@wisecom/atlas-s3';
import { bind_outlook } from '@wisecom/atlas-outlook';
import { bind_onedrive } from '@wisecom/atlas-onedrive';
import { bind_contacts } from '@wisecom/atlas-contacts';
import { bind_calendar } from '@wisecom/atlas-calendar';
import { bind_sharepoint } from '@wisecom/atlas-sharepoint';
import { bind_teams } from '@wisecom/atlas-teams';

/** Builds the DI container for the selected tenant profile. */
export function compose_container(options: LoadConfigOptions = {}): Container {
  let config: AtlasConfig;
  try {
    config = load_config(options);
  } catch (cause) {
    throw new ConfigError('Cannot load Atlas configuration.', { cause });
  }
  return compose_container_from_config(config);
}

/**
 * Builds the container a cross-tenant restore writes through: storage, region and passphrase
 * stay the source's, since they are what reads and decrypts the backup, while Graph signs in
 * with the target profile's credentials.
 */
export function compose_target_container(source: AtlasConfig, target_profile: string): Container {
  let graph: GraphConfig;
  try {
    graph = load_tenant_profile(target_profile);
  } catch (cause) {
    throw new ConfigError(`Cannot load tenant profile "${target_profile}".`, { cause });
  }
  return compose_container_from_config({ ...source, ...graph });
}

/** Builds the Atlas DI container from an explicit config (for tests and tooling). */
export function compose_container_from_config(config: AtlasConfig): Container {
  const container = new Container();
  container.bind<AtlasConfig>(ATLAS_CONFIG_TOKEN).toConstantValue(config);
  bind_graph_client(container, config);
  bind_s3_storage(container, config);
  bind_core_services(container);
  container.bind(USER_IDENTITY_RESOLVER_TOKEN).to(CachingIdentityResolver).inSingletonScope();
  bind_outlook(container);
  bind_onedrive(container);
  bind_contacts(container);
  bind_calendar(container);
  bind_sharepoint(container);
  bind_teams(container);
  return container;
}
