import { InvalidArgumentError, Option, type Command } from 'commander';

/**
 * Option groups shared by every command group, so one concept is spelled one way everywhere.
 *
 * Registration composes these instead of repeating `.option()` calls: a workload cannot drift into
 * its own vocabulary, and a flag that belongs to a group (Object Lock retention and mode) cannot be
 * half-registered, which is how `--lock-mode` ended up documenting its values in prose on four
 * commands while accepting anything (issue #162).
 */

/** Object Lock modes S3 accepts; the same list validates the flag and documents it. */
export const LOCK_MODES = ['governance', 'compliance'] as const;

/** File conflict policies a drive restore can apply. */
export const CONFLICT_MODES = ['replace', 'rename', 'fail'] as const;

/** What `atlas stats --service` accepts, including the all-services default. */
export const STATS_SERVICES = ['outlook', 'onedrive', 'sharepoint', 'all'] as const;

/** `-t, --tenant`: every command reads the tenant from the flag or falls back to config. */
export function with_tenant(command: Command): Command {
  return command.option('-t, --tenant <id>', 'tenant identifier (defaults to config)');
}

/** `-s, --snapshot`: `-s` is the snapshot on every command that has one, and nothing else. */
export function with_snapshot(command: Command, description: string): Command {
  return command.option('-s, --snapshot <id>', description);
}

/** `-s, --snapshot`, required: same spelling as {@link with_snapshot} where the id is mandatory. */
export function with_required_snapshot(command: Command, description: string): Command {
  return command.requiredOption('-s, --snapshot <id>', description);
}

/**
 * `--retention-days` plus `--lock-mode`, which are only meaningful together.
 *
 * The mode is validated by commander rather than by prose, so a typo fails before Atlas opens a
 * Graph connection instead of applying no lock at all.
 */
export function with_object_lock(command: Command, retention_description: string): Command {
  return command
    .option('--retention-days <n>', retention_description)
    .addOption(
      new Option('--lock-mode <mode>', 'Object Lock mode; requires --retention-days').choices([
        ...LOCK_MODES,
      ]),
    );
}

/**
 * `--output`: an archive path, with no short flag on any command.
 *
 * `-o` is the owner everywhere it appears, so the output path gives up its short spelling rather
 * than mean two things. `-O` was the drive spelling and is rejected outright.
 */
export function with_output(command: Command, description: string): Command {
  return reject_retired_short(command.option('--output <path>', description), '-O', '--output');
}

/** `-c, --conflict`: the drive restore file conflict policy, defaulting to a non-destructive rename. */
export function with_conflict(command: Command): Command {
  return command.addOption(
    new Option('-c, --conflict <mode>', 'file conflict policy')
      .choices([...CONFLICT_MODES])
      .default('rename'),
  );
}

/** `--file-filter`: restrict a drive operation to specific files, by ID or path. */
export function with_file_filter(command: Command, verb: string): Command {
  return command.option('--file-filter <paths...>', `only ${verb} specific files (by ID or path)`);
}

/** `-f, --folder`: one folder name, the arity every Outlook command now shares. */
export function with_folder(command: Command, description: string): Command {
  return command.option('-f, --folder <name>', description);
}

/**
 * `-f, --folder`, repeatable: `-f Inbox -f "Sent Items"`.
 *
 * Outlook backup used to take a variadic `<name...>` while restore and save took a single value, so
 * the same flag had two arities within one command group and a variadic `-f` swallowed the next
 * flag's argument. Repeating the flag keeps multiple folders reachable at one arity.
 */
export function with_repeatable_folder(command: Command, description: string): Command {
  return command.option(
    '-f, --folder <name>',
    description,
    (value: string, previous?: string[]) => [...(previous ?? []), value],
  );
}

/** `-y, --yes`: skip the confirmation prompt on a destructive command. */
export function with_yes(command: Command): Command {
  return command.option('-y, --yes', 'skip confirmation prompt');
}

/**
 * Fails a short flag that used to mean something else, naming what to pass instead.
 *
 * v5.0.0 reassigns `-s`, `-o`, and `-O`. A script that kept the old spelling must break loudly:
 * silently resolving `atlas stats -s <site>` as a snapshot id would back up or report on the wrong
 * thing, which is a data bug rather than a breaking change (issue #322).
 */
export function reject_retired_short(
  command: Command,
  short: string,
  replacement: string,
): Command {
  // Short-only and hidden: it exists to be caught, so it gets no long spelling that could read
  // like a supported flag, and `-o` next to `-O` stay separate options on one command.
  return command.addOption(
    new Option(`${short} <value>`, `retired: use ${replacement}`).hideHelp().argParser(() => {
      throw new InvalidArgumentError(
        `${short} no longer means ${replacement} in v5.0.0. Pass ${replacement} instead.`,
      );
    }),
  );
}
