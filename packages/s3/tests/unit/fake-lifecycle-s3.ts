import {
  DeleteBucketLifecycleCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  type LifecycleRule,
  type TransitionDefaultMinimumObjectSize,
} from '@aws-sdk/client-s3';
import { vi } from 'vitest';

export interface FakeLifecycleOptions {
  /** The configuration already on the bucket; undefined means none. */
  readonly rules?: LifecycleRule[] | undefined;
  readonly transition_default_minimum_object_size?: TransitionDefaultMinimumObjectSize;
  /** Stores every rule without its filter, as a backend that ignores filters would. */
  readonly drop_filters?: boolean;
  /** Fails a lifecycle put whose rules this returns an error for. */
  readonly refuse_put?: (rules: readonly LifecycleRule[]) => Error | undefined;
  /** Fails every lifecycle read, from the given call on (1-based). */
  readonly refuse_get?: { readonly error: Error; readonly from_call: number };
}

export interface FakeLifecycleS3 {
  readonly client: { send: ReturnType<typeof vi.fn> };
  /** The configuration the bucket holds now, or undefined when it has none. */
  readonly stored: () => LifecycleRule[] | undefined;
  readonly stored_transition_size: () => TransitionDefaultMinimumObjectSize | undefined;
  /** How many commands of the given class were sent. */
  readonly count: (command_class: new (...args: never[]) => unknown) => number;
}

/** A named error shaped like an S3 service exception. */
export function s3_named_error(name: string): Error {
  return Object.assign(new Error(name), { name });
}

/**
 * An S3 client that keeps one bucket's lifecycle configuration and answers every other command
 * with an empty response, so a test asserts what ends up stored rather than a call sequence.
 */
export function fake_lifecycle_s3(options: FakeLifecycleOptions = {}): FakeLifecycleS3 {
  let stored = options.rules === undefined ? undefined : structuredClone(options.rules);
  let transition_size = options.transition_default_minimum_object_size;
  let gets = 0;
  const sent: unknown[] = [];

  const send = vi.fn(async (command: unknown) => {
    sent.push(command);
    if (command instanceof GetBucketLifecycleConfigurationCommand) {
      gets++;
      const refusal = options.refuse_get;
      if (refusal !== undefined && gets >= refusal.from_call) throw refusal.error;
      if (stored === undefined) throw s3_named_error('NoSuchLifecycleConfiguration');
      return {
        Rules: structuredClone(stored),
        TransitionDefaultMinimumObjectSize: transition_size,
      };
    }
    if (command instanceof PutBucketLifecycleConfigurationCommand) {
      const rules = command.input.LifecycleConfiguration?.Rules ?? [];
      const refused = options.refuse_put?.(rules);
      if (refused !== undefined) throw refused;
      stored = structuredClone(rules).map((rule) =>
        options.drop_filters === true ? { ...rule, Filter: {} } : rule,
      );
      transition_size = command.input.TransitionDefaultMinimumObjectSize;
      return {};
    }
    if (command instanceof DeleteBucketLifecycleCommand) {
      stored = undefined;
      return {};
    }
    return {};
  });

  return {
    client: { send },
    stored: () => stored,
    stored_transition_size: () => transition_size,
    count: (command_class) => sent.filter((command) => command instanceof command_class).length,
  };
}
