import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { compose_target_container } from '@/container';
import type { KeyValueItem } from '@/ui/components/key-value-list';

/**
 * Refuses a cross-tenant restore that does not name its destination. Object IDs differ between
 * tenants, so the target is never guessed from the source. Runs before any Graph or storage call.
 */
export function require_target_for_profile(
  target_profile: string | undefined,
  target: string | undefined,
  flag: string,
): void {
  if (target_profile === undefined || target !== undefined) return;
  throw new Error(
    `--target-profile requires ${flag}: object IDs differ between tenants, so the destination is never guessed.`,
  );
}

/**
 * The container a restore's writes go through. A target profile swaps in its Graph credentials
 * while storage, region, and passphrase stay the source's; without one, the source container is used.
 */
export function resolve_restore_container(
  container: Container,
  target_profile: string | undefined,
): Container {
  if (target_profile === undefined) return container;
  return compose_target_container(container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN), target_profile);
}

/** Banner rows naming the target profile and its tenant; empty when the restore stays in the source tenant. */
export function target_profile_items(
  target_profile: string | undefined,
  restore_container: Container,
): KeyValueItem[] {
  if (target_profile === undefined) return [];
  return [
    { label: 'Target profile', value: target_profile },
    {
      label: 'Target tenant',
      value: restore_container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id,
    },
  ];
}
