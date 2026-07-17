import { Box, Static, Text } from 'ink';
import type { ReactElement } from 'react';
import { useSyncExternalStore } from 'react';
import { format_duration } from '@wisecom/atlas-core/services/shared/progress-rate';
import type {
  TransferProgressState,
  TransferProgressStore,
  TransferRow,
} from '@/ui/dashboards/transfer-progress-store';

/** Past-tense item verb, e.g. `saved` or `restored`. */
export type TransferVerb = 'saved' | 'restored';

function pad_name(name: string, width = 28): string {
  return name.length > width ? name.slice(0, width - 1) + '~' : name.padEnd(width);
}

function TransferRowLine({ row, verb }: { row: TransferRow; verb: TransferVerb }): ReactElement {
  const name = pad_name(row.name);

  switch (row.status) {
    case 'pending':
      return <Text color="gray">{`[  ] ${name} ${row.total_items} items`}</Text>;
    case 'active':
      return (
        <Text color="cyan">
          {`[>>] ${name} ${row.transferred}/${row.total_items}`}
          {row.integrity_fail > 0 ? (
            <Text color="red">{` ${row.integrity_fail}!`}</Text>
          ) : undefined}
          {` | ${row.rate.toFixed(1)} msg/s | ETA ${format_duration(row.eta_seconds)}`}
        </Text>
      );
    case 'done':
      return (
        <Text color="green">
          {`[ok] ${name} ${row.transferred} ${verb}` +
            (row.attachments > 0 ? `, ${row.attachments} att` : '')}
          {row.integrity_fail > 0 ? (
            <Text color="red">{` (${row.integrity_fail} failed)`}</Text>
          ) : undefined}
        </Text>
      );
    case 'skipped':
      return <Text color="gray">{`[--] ${name} 0 items -- skipped`}</Text>;
    case 'interrupted':
      return <Text color="yellow">{`[~~] ${name} -- interrupted`}</Text>;
    case 'error':
      return <Text color="red">{`[!!] ${name} ERROR: ${row.error_message}`}</Text>;
  }
}

function TotalRow({ state }: { state: TransferProgressState }): ReactElement {
  if (state.global_total === 0) {
    return <Text>{'---- TOTAL                          --'}</Text>;
  }
  if (state.finalizing) {
    return (
      <Text>
        {`---- TOTAL${' '.repeat(18)} ` +
          `${state.global_processed}/${state.global_total} | finalizing...`}
      </Text>
    );
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
 * Folder-by-folder transfer dashboard for save/restore operations. Finished
 * folders scroll into terminal history via `<Static>`; the live region stays
 * within screen height regardless of folder count.
 */
export function TransferProgressView({
  store,
  verb,
}: {
  store: TransferProgressStore;
  verb: TransferVerb;
}): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.get_snapshot);

  const active = state.rows.filter((row) => row.status === 'active');
  const pending_count = state.rows.filter((row) => row.status === 'pending').length;

  return (
    <Box flexDirection="column">
      <Static items={state.completed_order}>
        {(row_index) => (
          <TransferRowLine key={row_index} row={state.rows[row_index]!} verb={verb} />
        )}
      </Static>
      {active.map((row) => (
        <TransferRowLine key={row.name} row={row} verb={verb} />
      ))}
      {pending_count > 0 ? (
        <Text color="gray">{`[  ] ${pending_count} folder(s) pending`}</Text>
      ) : undefined}
      <TotalRow state={state} />
    </Box>
  );
}
