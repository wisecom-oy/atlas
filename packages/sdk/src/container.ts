import 'reflect-metadata';
import { Container } from 'inversify';
import { type AtlasConfig, ATLAS_CONFIG_TOKEN, CachingIdentityResolver } from '@wisecom/atlas-core';
import { bind_core_services } from '@wisecom/atlas-core';
import { USER_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-types';
import type { ThrottleCoordinator } from '@wisecom/atlas-types';
import { bind_graph_client } from '@wisecom/atlas-m365-graph';
import { bind_s3_storage } from '@wisecom/atlas-s3';
import { bind_outlook } from '@wisecom/atlas-outlook';
import { bind_onedrive } from '@wisecom/atlas-onedrive';
import { bind_sharepoint } from '@wisecom/atlas-sharepoint';

/**
 * Builds the SDK container exclusively from explicit configuration. `throttle` replaces the
 * in-memory Graph throttle coordinator.
 */
export function create_container_from_config(
  config: AtlasConfig,
  throttle?: ThrottleCoordinator,
): Container {
  const container = new Container();
  container.bind<AtlasConfig>(ATLAS_CONFIG_TOKEN).toConstantValue(config);
  bind_graph_client(container, config, throttle);
  bind_s3_storage(container, config);
  bind_core_services(container);
  container.bind(USER_IDENTITY_RESOLVER_TOKEN).to(CachingIdentityResolver).inSingletonScope();
  bind_outlook(container);
  bind_onedrive(container);
  bind_sharepoint(container);
  return container;
}
