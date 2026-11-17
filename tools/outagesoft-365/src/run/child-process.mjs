/**
 * Spawning the command under test (with the preload) and the verify command
 * (without it).
 *
 * Signals: SIGTERM and SIGHUP are forwarded to the child. SIGINT is forwarded
 * only when stdin is not a terminal. A Ctrl-C at a terminal already reaches
 * the child, because it shares the foreground process group; sending a second
 * copy would turn Atlas's graceful first-interrupt into a forced abort. The
 * child is kept in that group (not detached) so interactive prompts keep
 * working.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { performance } from 'node:perf_hooks';

/** The preload as a file URL: `--import` treats a bare `C:\...` path as a URL with scheme `c:`. */
const PRELOAD_URL = new URL('../preload/preload.mjs', import.meta.url).href;

/** Environment variables that belong to a relayed child and must not leak into the verify command. */
const RELAY_ENV = ['OUTAGESOFT_RELAY', 'OUTAGESOFT_TOKEN', 'OUTAGESOFT_TEST_FORCE'];

/** NODE_OPTIONS with the preload appended; a file URL, quoted, so Windows drive letters and spaces survive. */
export function node_options_with_preload(existing) {
  const flag = `--import="${PRELOAD_URL}"`;
  return [existing, flag].filter(Boolean).join(' ');
}

/** Waits for a spawned process to finish; resolves { exit_code, signal, duration_ms, error? }. */
function wait_for_exit(child, started) {
  return new Promise((resolve) => {
    child.once('error', (error) => {
      resolve({
        exit_code: null,
        signal: null,
        duration_ms: Math.round(performance.now() - started),
        error: error.code ?? 'spawn failed',
      });
    });
    child.once('exit', (code, signal) => {
      resolve({ exit_code: code, signal, duration_ms: Math.round(performance.now() - started) });
    });
  });
}

/** Installs signal forwarding to `child`; returns { interrupted(), remove() }. */
function forward_signals(child) {
  let interrupted = false;
  const handlers = {};
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    handlers[signal] = () => {
      interrupted = true;
      if (signal === 'SIGINT' && process.stdin.isTTY) return;
      try {
        child.kill(signal);
      } catch {
        /* the child already exited */
      }
    };
    process.on(signal, handlers[signal]);
  }
  return {
    interrupted: () => interrupted,
    remove: () =>
      Object.entries(handlers).forEach(([signal, handler]) => process.off(signal, handler)),
  };
}

/**
 * Spawns and waits. `spawn` can also throw synchronously (an empty command,
 * an invalid argument); that becomes the same `{ error }` result as an async
 * spawn failure, so `run` finalises the journal and report either way.
 */
async function spawn_and_wait(file, args, options) {
  const started = performance.now();
  let child;
  try {
    child = spawn(file, args, options);
  } catch (error) {
    return {
      exit_code: null,
      signal: null,
      duration_ms: 0,
      error: error.code ?? 'spawn failed',
      interrupted: false,
    };
  }
  const signals = forward_signals(child);
  const result = await wait_for_exit(child, started);
  signals.remove();
  return { ...result, interrupted: signals.interrupted() };
}

/** Runs the command under test with the preload and relay env; resolves its exit facts. */
export function run_child_with_preload(command, relay_url, token) {
  const env = {
    ...process.env,
    NODE_OPTIONS: node_options_with_preload(process.env.NODE_OPTIONS),
    OUTAGESOFT_RELAY: relay_url,
    OUTAGESOFT_TOKEN: token,
  };
  return spawn_and_wait(command[0], command.slice(1), {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

/** Runs the --verify-cmd string through the shell, without the preload, against the real service. */
export function run_verify_command(command_line) {
  const env = { ...process.env };
  for (const name of RELAY_ENV) delete env[name];
  return spawn_and_wait(command_line, [], { env, stdio: 'inherit', shell: true });
}

/** The exit code `run` returns for a child result: its own code, 128 + signal number, or 127 if it never started. */
export function exit_code_for(result) {
  if (result.error) return 127;
  if (result.exit_code !== null && result.exit_code !== undefined) return result.exit_code;
  return 128 + (constants.signals[result.signal] ?? 0);
}
