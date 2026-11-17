/**
 * Fixture entry that names `HiddenEvent` in a callback alias and `HiddenOptions` in a method
 * without exporting either, which the export walk must report.
 */
import type { HiddenEvent, HiddenOptions } from './public-surface-hidden.fixtures';

export type EventCallback = (event: HiddenEvent) => void;

export interface FixtureApi {
  run(options?: HiddenOptions): Promise<void>;
}
