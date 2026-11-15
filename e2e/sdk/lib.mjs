/**
 * Shared plumbing for the SDK scenario scripts: instance creation, error capture, event
 * recording and the single JSON document each script prints.
 *
 * Every script loads `packages/sdk/dist/index.mjs`, the file that goes to npm, so the suite drives
 * the published bundle rather than the sources. Configuration comes from the same ATLAS_*
 * variables the CLI reads, and scenario inputs from E2E_* variables: never from argv, which shows
 * up in process listings.
 *
 * Output carries counts, booleans, snapshot ids and error codes. Anything Atlas hands over that
 * can hold tenant data (a progress event's `current`, a message body, a Graph id) is dropped here
 * or in the script before it is printed.
 */

import * as sdk from '../../packages/sdk/dist/index.mjs';

export { sdk };

/** Reads a variable the scenario cannot run without. */
export function required_env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Instance configuration from the ATLAS_* variables, with per-scenario overrides. */
export function instance_config(overrides = {}) {
  return {
    tenantId: required_env('ATLAS_TENANT_ID'),
    clientId: required_env('ATLAS_CLIENT_ID'),
    clientSecret: required_env('ATLAS_CLIENT_SECRET'),
    s3Endpoint: required_env('ATLAS_S3_ENDPOINT'),
    s3AccessKey: required_env('ATLAS_S3_ACCESS_KEY'),
    s3SecretKey: required_env('ATLAS_S3_SECRET_KEY'),
    s3Region: process.env.ATLAS_S3_REGION ?? 'us-east-1',
    encryptionPassphrase: required_env('ATLAS_ENCRYPTION_PASSPHRASE'),
    ...overrides,
  };
}

/** A configured instance. The caller disposes it. */
export function create_instance(overrides = {}) {
  return sdk.createAtlasInstance(instance_config(overrides));
}

/** Error classes a scenario may expect, matched with `instanceof` rather than by name. */
const ERROR_CLASSES = {
  AtlasError: sdk.AtlasError,
  ConfigError: sdk.ConfigError,
  NotFoundError: sdk.NotFoundError,
  WrongPassphraseError: sdk.WrongPassphraseError,
  AuthError: sdk.AuthError,
  StorageError: sdk.StorageError,
  TypeError,
};

/** What was thrown, reduced to its code and classes. The message is left out: it can name owners. */
export function describe_error(err) {
  return {
    thrown: true,
    code: typeof err?.code === 'string' ? err.code : null,
    classes: Object.entries(ERROR_CLASSES)
      .filter(([, error_class]) => err instanceof error_class)
      .map(([name]) => name),
  };
}

/** Runs an async call that is expected to reject, and describes how it did. */
export async function capture(call) {
  try {
    await call();
    return { thrown: false };
  } catch (err) {
    return describe_error(err);
  }
}

/** The synchronous form of `capture`, for constructors and factories. */
export function capture_sync(call) {
  try {
    call();
    return { thrown: false };
  } catch (err) {
    return describe_error(err);
  }
}

/**
 * Records progress events without `current`, which carries a message subject or object id.
 * `keys` keeps the field names the event really had, so the shape can still be checked.
 */
export function progress_recorder(on_event = () => {}) {
  const events = [];
  const on_progress = (event) => {
    const kept = Object.entries(event).filter(([key]) => key !== 'current');
    events.push({ ...Object.fromEntries(kept), keys: Object.keys(event).sort() });
    on_event(event);
  };
  return { events, on_progress };
}

/** Records storage request events as they arrive. By contract they carry no key or identifier. */
export function storage_recorder() {
  const events = [];
  return { events, on_storage_request: (event) => events.push({ ...event }) };
}

/**
 * Runs a scenario and prints its result as one JSON document.
 *
 * A failure prints `{ "error": ... }` and exits 1. The message is included for diagnosis because
 * the Python runner scrubs both streams before any of it reaches a log or an assertion.
 * `process.exit` ends the run even if a keep-alive socket or timer is left; stdout to a pipe is
 * written synchronously on Linux, so nothing printed is lost.
 */
export async function main(scenario) {
  let code = 0;
  let output;
  try {
    output = await scenario();
  } catch (err) {
    code = 1;
    const message = err instanceof Error ? err.message : String(err);
    output = { error: { ...describe_error(err), message: message.slice(0, 2000) } };
  }
  process.stdout.write(JSON.stringify(output));
  process.exit(code);
}
