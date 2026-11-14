/**
 * A tiny named-check collector for the selfcheck: prints `  ok  <name>` like
 * graph-tap's selfcheck, keeps going after a failure so one run shows every
 * broken check, and reports the totals at the end.
 */

/** Creates a collector; `check(name, fn)` runs fn (sync or async) and records the result. */
export function create_check_list() {
  const passed = [];
  const failed = [];
  return {
    async check(name, fn) {
      try {
        await fn();
        passed.push(name);
        console.log(`  ok  ${name}`);
      } catch (error) {
        failed.push(name);
        console.log(
          `  FAIL  ${name}\n        ${String(error?.message ?? error)
            .split('\n')
            .join('\n        ')}`,
        );
      }
    },
    passed,
    failed,
  };
}
