import type {
  DriveRestoreSkippedItem,
  DriveSharingRefusal,
  DriveSharingRestoreSummary,
} from '@wisecom/atlas-types';

/** The reason an operator reads for each Graph refusal. */
const REFUSAL_REASON: Readonly<Record<Exclude<DriveSharingRefusal, 'rejected'>, string>> = {
  principal_unresolved: 'grantee no longer exists or cannot be resolved in this tenant',
  sharing_disabled: 'sharing of this kind is disabled by tenant or site policy',
};

/** The reason text for a refusal Graph returned. */
export function describe_refusal(refusal: DriveSharingRefusal, message: string): string {
  if (refusal === 'rejected') return `Graph refused it: ${message}`;
  return REFUSAL_REASON[refusal];
}

/**
 * Counts what a restore did with permissions, and why it left any out. Kept apart from the run's
 * `errors`, so an expected outcome such as a deleted grantee never turns the exit code partial.
 */
export class SharingRestoreTally {
  private _permissions_applied = 0;
  private _permissions_skipped = 0;
  private _permissions_not_requested = 0;
  private readonly _skipped: DriveRestoreSkippedItem[] = [];

  /** Counts one reapplied grant or link. */
  permission_applied(): void {
    this._permissions_applied++;
  }

  /** Records one grant or link that was requested and not reapplied, and why. */
  permission_skipped(path: string, detail: string, reason: string): void {
    this._permissions_skipped++;
    this._skipped.push({ path, kind: 'permission', detail, reason });
  }

  /** Counts grants and links left out because the restore did not ask for permissions. */
  permissions_not_requested(count: number): void {
    this._permissions_not_requested += count;
  }

  /** The result fields, set only when non-zero so a restore without sharing reads as before. */
  summary(): DriveSharingRestoreSummary {
    return {
      ...(this._permissions_applied > 0 && { permissions_applied: this._permissions_applied }),
      ...(this._permissions_skipped > 0 && { permissions_skipped: this._permissions_skipped }),
      ...(this._permissions_not_requested > 0 && {
        permissions_not_requested: this._permissions_not_requested,
      }),
      ...(this._skipped.length > 0 && { skipped_items: [...this._skipped] }),
    };
  }
}
