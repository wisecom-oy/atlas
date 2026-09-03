import { describe, expect, it } from 'vitest';
import type {
  AtlasInstanceConfig,
  OperationCost,
  GraphServiceLimits,
  ObjectLockRequest,
  OutlookBackupOptions,
  OutlookBackupResult,
  OutlookRestoreOptions,
  OutlookSaveOptions,
  OutlookSaveResult,
  OutlookSnapshotManifest,
  OutlookMailboxSummary,
  OutlookMailboxStatus,
  OneDriveSdkBackupOptions,
  OneDriveSdkBackupResult,
  OneDriveSdkRestoreOptions,
  OneDriveSdkSaveOptions,
  OneDriveSdkSnapshotManifest,
  OneDriveSdkStatusResult,
  SharePointSdkBackupOptions,
  SharePointSdkBackupResult,
  SharePointSdkRestoreOptions,
  SharePointSdkStatusResult,
  SdkOperationOptions,
  StorageTargetSdkConfig,
} from '@/index';
import { camelize } from '@wisecom/atlas-types/public/case-convert';
import { GRAPH_SERVICE_LIMITS } from '@/public-values';

/**
 * Compile-time guard for the public surface.
 *
 * `SnakeKeys<T>` resolves to the keys carrying an underscore, at every depth. Assigning `true` to
 * `NoSnakeKeys<T>` therefore fails to compile the moment a snake_case field reaches the public
 * types, which is the drift this replaces: the SDK documented camelCase and shipped snake_case for
 * four major versions because nothing checked (issue #45).
 *
 * `pnpm run typecheck` covers `tests/`, so this file is the check.
 */
type SnakeKeys<T> = T extends readonly (infer Item)[]
  ? SnakeKeys<Item>
  : T extends Date | Buffer | AbortSignal | ((...args: never[]) => unknown)
    ? never
    : T extends object
      ? {
          [K in keyof T]-?: K extends `${string}_${string}`
            ? K
            : K extends 'message'
              ? never
              : K extends 'deltaLinks' | 'requestsByType' | 'byService'
                ? // The map's own keys are data and are skipped; the values under them are ours,
                  // so a `request_count` inside `byService` is still a violation.
                  SnakeKeys<T[K][keyof T[K]]>
                : SnakeKeys<T[K]>;
        }[keyof T]
      : never;

type NoSnakeKeys<T> = [SnakeKeys<T>] extends [never] ? true : SnakeKeys<T>;

const config_is_camel: NoSnakeKeys<AtlasInstanceConfig> = true;
const cost_is_camel: NoSnakeKeys<OperationCost> = true;
const object_lock_request_is_camel: NoSnakeKeys<ObjectLockRequest> = true;
const operation_options_are_camel: NoSnakeKeys<SdkOperationOptions> = true;
const storage_target_config_is_camel: NoSnakeKeys<StorageTargetSdkConfig> = true;

const outlook_options_are_camel: NoSnakeKeys<
  OutlookBackupOptions | OutlookRestoreOptions | OutlookSaveOptions
> = true;
const outlook_results_are_camel: NoSnakeKeys<
  | OutlookBackupResult
  | OutlookSaveResult
  | OutlookSnapshotManifest
  | OutlookMailboxSummary
  | OutlookMailboxStatus
> = true;

const onedrive_options_are_camel: NoSnakeKeys<
  OneDriveSdkBackupOptions | OneDriveSdkRestoreOptions | OneDriveSdkSaveOptions
> = true;
const onedrive_results_are_camel: NoSnakeKeys<
  OneDriveSdkBackupResult | OneDriveSdkSnapshotManifest | OneDriveSdkStatusResult
> = true;

const sharepoint_options_are_camel: NoSnakeKeys<
  SharePointSdkBackupOptions | SharePointSdkRestoreOptions
> = true;
const sharepoint_results_are_camel: NoSnakeKeys<
  SharePointSdkBackupResult | SharePointSdkStatusResult
> = true;

describe('public surface', () => {
  it('declares no snake_case field at any depth', () => {
    // The assertions above are the test; a violation is a type error, not a failed expectation.
    expect([
      config_is_camel,
      operation_options_are_camel,
      storage_target_config_is_camel,
      outlook_options_are_camel,
      outlook_results_are_camel,
      onedrive_options_are_camel,
      onedrive_results_are_camel,
      sharepoint_options_are_camel,
      sharepoint_results_are_camel,
      cost_is_camel,
      object_lock_request_is_camel,
    ]).toEqual(Array.from({ length: 11 }, () => true));
  });

  it('keeps the keys of maps Atlas did not choose', () => {
    // The exemptions in SnakeKeys above are not a loophole for our own fields: these keys are
    // data, and the guard has to allow exactly them and nothing else.
    const cost = camelize({
      requests_total: 1,
      by_service: { sharepoint_onedrive: { request_count: 1 } },
      requests_by_type: { delta_sync: 1 },
      elapsed_ms: 2,
    });

    expect(Object.keys(cost)).toEqual([
      'requestsTotal',
      'byService',
      'requestsByType',
      'elapsedMs',
    ]);
    expect(Object.keys(cost.byService)).toEqual(['sharepoint_onedrive']);
    expect(Object.keys(cost.requestsByType)).toEqual(['delta_sync']);
    expect(cost.byService.sharepoint_onedrive).toEqual({ requestCount: 1 });
  });

  it('spells a pool the same way in GRAPH_SERVICE_LIMITS and in a cost', () => {
    const cost = camelize({
      requests_total: 0,
      by_service: { sharepoint_onedrive: { request_count: 0 } },
      requests_by_type: {},
      elapsed_ms: 0,
    });

    // A caller reads a pool name off a cost and indexes the limits with it. Camelising the limits
    // root gave `sharepointOnedrive` here and `sharepoint_onedrive` there, so that lookup
    // returned undefined for the drive pool.
    for (const pool of Object.keys(cost.byService)) {
      expect(GRAPH_SERVICE_LIMITS).toHaveProperty(pool);
    }
    expect(Object.keys(GRAPH_SERVICE_LIMITS)).toContain('sharepoint_onedrive');
    expect(GRAPH_SERVICE_LIMITS.sharepoint_onedrive.resourceUnitsPerMinute).toBeDefined();
  });
});
