/**
 * Case conversion for the public SDK surface.
 *
 * Atlas is snake_case internally, which `.claude/CLAUDE.md` mandates and every service and domain
 * model follows. The SDK is camelCase, which its methods and config already were and its docs
 * always claimed. Before v5.0.0 only the *methods* honoured that, so consumers read
 * `createAtlasInstance` and then guessed at `force_full`, `restored_count` and `graph_cost`
 * (issue #45).
 *
 * The conversion is one mapped type plus one recursive function rather than sixty hand-mirrored
 * interfaces. Hand-mirroring drifts the first time somebody adds a field to a manifest and forgets
 * the copy; a mapped type cannot.
 */

/** Snake to camel for a single key. */
export type CamelKey<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelKey<Tail>>}`
  : S;

/** Camel to snake for a single key. */
export type SnakeKey<S extends string> = S extends `${infer Head}${infer Tail}`
  ? Head extends Uppercase<Head>
    ? Head extends Lowercase<Head>
      ? `${Head}${SnakeKey<Tail>}`
      : `_${Lowercase<Head>}${SnakeKey<Tail>}`
    : `${Head}${SnakeKey<Tail>}`
  : S;

/**
 * Values passed through untouched rather than descended into.
 *
 * `Buffer` and `Date` are objects with their own keys, and a converted `Date` would be an empty
 * object. Functions are progress hooks and reporter factories.
 */
type Passthrough = Date | Buffer | AbortSignal | ((...args: never[]) => unknown);

/**
 * Keys whose value is somebody else's data and is never touched at all.
 *
 * `message` holds the raw Graph JSON payload for a stored message. Renaming inside it would hand
 * back a message whose `@odata.etag` and `internetMessageHeaders` no longer match what Graph
 * returned or what the blob contains, which is data corruption rather than a rename.
 */
export const OPAQUE_VALUE_KEYS = ['message'] as const;

/**
 * Keys whose value is a map with data-derived or externally-meaningful keys. The map's own keys
 * are preserved; the values beneath them are still converted.
 *
 * `delta_links` is keyed by Graph folder id, `requests_by_type` by request shape, `by_service` by
 * pool name, and pool names are identifiers that also appear in `GRAPH_SERVICE_LIMITS`, so
 * `sharepoint_onedrive` must not become `sharepointOnedrive` in one place and not the other.
 *
 * These two lists are the only part of this module maintained by hand. A key added to either needs
 * a test proving the payload survives; see `case-convert.test.ts`.
 */
export const PRESERVED_MAP_KEYS = [
  'delta_links',
  'requests_by_type',
  'by_service',
  // The camelCase spellings too: `snakeize` walks public values, where these fields already
  // carry their public names, and it has to preserve the same map keys on the way back in.
  'deltaLinks',
  'requestsByType',
  'byService',
] as const;

/** The same lists at the type level, so `Camelize` and the runtime converter cannot disagree. */
export type OpaqueValueKey = (typeof OPAQUE_VALUE_KEYS)[number];
export type PreservedMapKey = (typeof PRESERVED_MAP_KEYS)[number];

/** The camelCase shape of an internal type, recursively. */
export type Camelize<T> = T extends Passthrough
  ? T
  : T extends (infer Item)[]
    ? Camelize<Item>[]
    : T extends readonly (infer Item)[]
      ? readonly Camelize<Item>[]
      : T extends object
        ? {
            [K in keyof T as K extends string ? CamelKey<K> : K]: K extends OpaqueValueKey
              ? T[K]
              : K extends PreservedMapKey
                ? { [MapKey in keyof T[K]]: Camelize<T[K][MapKey]> }
                : Camelize<T[K]>;
          }
        : T;

/** The internal snake_case shape of a public type, recursively. */
export type Snakeize<T> = T extends Passthrough
  ? T
  : T extends (infer Item)[]
    ? Snakeize<Item>[]
    : T extends readonly (infer Item)[]
      ? readonly Snakeize<Item>[]
      : T extends object
        ? {
            [K in keyof T as K extends string ? SnakeKey<K> : K]: K extends OpaqueValueKey
              ? T[K]
              : K extends PreservedMapKey
                ? { [MapKey in keyof T[K]]: Snakeize<T[K][MapKey]> }
                : Snakeize<T[K]>;
          }
        : T;

/** Converts an internal value to its public camelCase form. */
export function camelize<T>(value: T): Camelize<T> {
  return convert(value, to_camel_key) as Camelize<T>;
}

/** Converts a public camelCase value to its internal snake_case form. */
export function snakeize<T>(value: T): Snakeize<T> {
  return convert(value, to_snake_key) as Snakeize<T>;
}

function convert(value: unknown, rename: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => convert(item, rename));
  if (!is_convertible_object(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const renamed = rename(key);
    if ((OPAQUE_VALUE_KEYS as readonly string[]).includes(key)) {
      out[renamed] = item;
    } else if ((PRESERVED_MAP_KEYS as readonly string[]).includes(key)) {
      out[renamed] = convert_map_values(item, rename);
    } else {
      out[renamed] = convert(item, rename);
    }
  }
  return out;
}

/**
 * True only for plain objects.
 *
 * A `Buffer` is an object, and iterating its entries would turn a message body into
 * `{ "0": 82, "1": 101, ... }`. `Date`, `AbortSignal` and class instances are the same hazard with
 * different symptoms, so anything that is not a bare object or a null-prototype object is left
 * alone.
 */
function is_convertible_object(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function to_camel_key(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function to_snake_key(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

/** Converts the values of a map while leaving its keys exactly as stored. */
function convert_map_values(value: unknown, rename: (key: string) => string): unknown {
  if (!is_convertible_object(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = convert(item, rename);
  return out;
}
