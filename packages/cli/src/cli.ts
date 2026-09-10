#!/usr/bin/env node
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { compose_container } from '@/container';
import { register_outlook_command } from '@/commands/outlook.command';
import { register_onedrive_command } from '@/commands/onedrive.command';
import { register_sharepoint_command } from '@/commands/sharepoint.command';
import { register_tenant_delete_command } from '@/commands/tenant-delete.command';
import { register_stats_command } from '@/commands/stats.command';
import { register_storage_check_command } from '@/commands/storage-check.command';
import { register_replicate_command } from '@/commands/replicate.command';
import { register_rehydrate_command } from '@/commands/rehydrate.command';
import { register_list_users_command } from '@/commands/list-users.command';
import { register_config_command } from '@/commands/config.command';
import { handle_fatal_error } from '@/fatal-error';
import type { Container } from 'inversify';

let _container: Container | undefined;

/** Lazily creates the DI container on first use, so --help works without config. */
export function get_container(): Container {
  if (!_container) {
    _container = compose_container();
  }
  return _container;
}

/** Builds the top-level Commander program with metadata. */
function create_program(): Command {
  // Works from src (tsx) and dist (bundle): both sit one level below package.json.
  const { version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return new Command()
    .name('atlas')
    .description('Atlas – Microsoft 365 backup to S3-compatible object storage (Wisecom Oy)')
    .version(version);
}

/** Registers all CLI subcommands against the program. */
function register_commands(program: Command): void {
  register_outlook_command(program, get_container);
  register_onedrive_command(program, get_container);
  register_sharepoint_command(program, get_container);
  register_tenant_delete_command(program, get_container);
  register_stats_command(program, get_container);
  register_storage_check_command(program, get_container);
  register_replicate_command(program, get_container);
  register_rehydrate_command(program, get_container);
  register_list_users_command(program, get_container);
  register_config_command(program);
}

const program = create_program();
register_commands(program);
program.parseAsync(process.argv).catch(handle_fatal_error);
