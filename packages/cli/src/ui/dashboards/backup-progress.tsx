import { Box, Static, Text } from 'ink';
import type { ReactElement } from 'react';
import { useSyncExternalStore } from 'react';
import { format_duration } from '@wisecom/atlas-core/services/shared/progress-rate';
import type {
  BackupProgressState,
  BackupProgressStore,
  FolderRow,
} from '@/ui/dashboards/backup-progress-store';

function pad_name(name: string, width = 28): string {
  return name.length > width ? name.slice(0, width - 1) + '~' : name.padEnd(width);
}

/** One folder line; glyphs and wording match the pre-Ink dashboard. */
function FolderRowLine({ row }: { row: FolderRow }): ReactElement {
  const name = pad_name(row.name);

  switch (row.status) {
    case 'pending':
      return <Text color="gray">{`[  ] ${name} ${row.total_items} items`}</Text>;
    case 'active':
      return (
        <Text color="cyan">
          {`[>>] ${name} ${row.processed}/${row.total_items}` +
            ` | ${row.rate.toFixed(1)} msg/s` +
            ` | ETA ${format_duration(row.eta_seconds)}`}
        </Text>
      );
    case 'paging':
      return (
        <Text color="cyan">
          {`[>>] ${name} fetching ${row.paging_fetched}/${row.total_items}` +
            ` | ${row.paging_rate.toFixed(1)} items/s` +
            ` | ETA ${format_duration(row.eta_seconds)}`}
        </Text>
      );
    case 'done':
      return (
        <Text color="green">
          {`[ok] ${name} ${row.processed} items` +
            ` -- ${row.stored} stored, ${row.deduped} dedup` +
            (row.attachments > 0 ? `, ${row.attachments} att` : '')}
        </Text>
      );
    case 'synced':
      return <Text color="yellow">{`[==] ${name} ${row.total_items} items -- up to date`}</Text>;
    case 'interrupted':
      return <Text color="yellow">{`[~~] ${name} -- interrupted`}</Text>;
    case 'empty':
      return <Text color="gray">{`[--] ${name} 0 items -- empty`}</Text>;
    case 'error':
      return <Text color="red">{`[!!] ${name} ERROR: ${row.error_message}`}</Text>;
  }
}

function TotalRow({ state }: { state: BackupProgressState }): ReactElement {
  if (state.global_total === 0) {
    return <Text>{'---- TOTAL                          --'}</Text>;
  }
  const done = state.global_processed >= state.global_total;
  const eta_str = done ? 'done' : `ETA ${format_duration(state.eta_seconds)}`;
  return (
    <Text>
      {`---- TOTAL${' '.repeat(18)} ` +
        `${state.global_processed}/${state.global_total}` +
        ` | ${state.rate.toFixed(1)} msg/s` +
        ` | ${eta_str}`}
    </Text>
  );
}

/**
 * Per-folder backup dashboard. Finished folders scroll into terminal history
 * via `<Static>`; the live region stays small (active rows + pending count +
 * TOTAL), so mailboxes with hundreds of folders never overflow the screen.
 */
export function BackupProgressView({ store }: { store: BackupProgressStore }): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get_snapshot);

  const in_flight = state.rows.filter((row) => row.status === 'active' || row.status === 'paging');
  const pending_count = state.rows.filter((row) => row.status === 'pending').length;

  return (
    <Box flexDirection="column">
      <Static items={state.completed_order}>
        {(row_index) => <FolderRowLine key={row_index} row={state.rows[row_index]!} />}
      </Static>
      {in_flight.map((row) => (
        <FolderRowLine key={row.name} row={row} />
      ))}
      {pending_count > 0 ? (
        <Text color="gray">{`[  ] ${pending_count} folder(s) pending`}</Text>
      ) : undefined}
      <TotalRow state={state} />
      {state.status_message === '' ? undefined : <Text color="yellow">{state.status_message}</Text>}
    </Box>
  );
}
