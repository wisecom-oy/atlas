#!/usr/bin/env node
import 'reflect-metadata';
import { Command } from 'commander';
import chalk from 'chalk';
import { create_container } from '@/container';
import { register_backup_command } from '@/cli/commands/backup.command';
import { register_verify_command } from '@/cli/commands/verify.command';
import { register_restore_command } from '@/cli/commands/restore.command';
import { register_list_command } from '@/cli/commands/list.command';
import { register_read_command } from '@/cli/commands/read.command';
import { register_delete_command } from '@/cli/commands/delete.command';
import { register_storage_check_command } from '@/cli/commands/storage-check.command';
import { register_save_command } from '@/cli/commands/save.command';
import { register_stats_command } from '@/cli/commands/stats.command';
import { register_mailboxes_command } from '@/cli/commands/mailboxes.command';
import { register_status_command } from '@/cli/commands/status.command';
import { logger } from '@/utils/logger';
import type { Container } from 'inversify';

let _container: Container | undefined;

/** Lazily creates the DI container on first use, so --help works without config. */
export function get_container(): Container {
  if (!_container) {
    _container = create_container();
  }
  return _container;
}

/** Builds the top-level Commander program with metadata. */
function create_program(): Command {
  return new Command()
    .name('atlas')
    .description(chalk.bold('m365-atlas') + ' – M365 email backup to S3-compatible object storage')
    .version('1.0.0');
}

/** Registers all CLI subcommands against the program. */
function register_commands(program: Command): void {
  register_backup_command(program, get_container);
  register_verify_command(program, get_container);
  register_restore_command(program, get_container);
  register_list_command(program, get_container);
  register_read_command(program, get_container);
  register_delete_command(program, get_container);
  register_storage_check_command(program, get_container);
  register_save_command(program, get_container);
  register_stats_command(program, get_container);
  register_mailboxes_command(program, get_container);
  register_status_command(program, get_container);
}

/** Handles top-level unhandled errors from command execution. */
function handle_fatal_error(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(message);

  if (err && typeof err === 'object') {
    const graph_err = err as Record<string, unknown>;
    if (graph_err.statusCode) logger.info(`  HTTP status: ${graph_err.statusCode}`);
    if (graph_err.code) logger.info(`  Error code: ${graph_err.code}`);
    if (graph_err.body) logger.info(`  Body: ${JSON.stringify(graph_err.body)}`);
    log_s3_connection_hint(graph_err, message);
    if (graph_err.stack && process.env.DEBUG) logger.info(String(graph_err.stack));
  }

  process.exitCode = 1;
}

function log_s3_connection_hint(err: Record<string, unknown>, message: string): void {
  const code = String(err.code ?? '');
  const lower_message = message.toLowerCase();
  const is_connection_error =
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    lower_message.includes('econnrefused') ||
    lower_message.includes('econnreset') ||
    lower_message.includes('socket hang up');

  if (!is_connection_error) return;

  const endpoint = process.env.ATLAS_S3_ENDPOINT;
  const endpoint_text = endpoint ? `"${endpoint}"` : 'ATLAS_S3_ENDPOINT';

  logger.error(
    `Cannot connect to S3 endpoint ${endpoint_text}. ` +
      `Check that your S3/MinIO service is running and reachable.`,
  );
  logger.info('  If using local MinIO: cd docker && docker compose up -d');
}

const program = create_program();
register_commands(program);
program.parseAsync(process.argv).catch(handle_fatal_error);
