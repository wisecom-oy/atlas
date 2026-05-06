import 'reflect-metadata';
import { Container } from 'inversify';
import {
  type AtlasConfig,
  load_config,
  ATLAS_CONFIG_TOKEN,
  CachingIdentityResolver,
} from '@atlas/core';
import { bind_core_services } from '@atlas/core';
import { USER_IDENTITY_RESOLVER_TOKEN } from '@atlas/types';
import { bind_graph_client } from '@atlas/m365-graph';
import { bind_s3_storage } from '@atlas/s3';
import { bind_outlook } from '@atlas/outlook';
import { bind_onedrive } from '@atlas/onedrive';

/** Builds the DI container with Graph, S3, core services, and Outlook use cases. */
export function compose_container(): Container {
  const config = load_config();
  return compose_container_from_config(config);
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
  return container;
}
