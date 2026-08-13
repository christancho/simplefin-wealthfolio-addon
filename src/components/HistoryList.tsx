import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@wealthfolio/ui';
import type { SyncRun } from '../lib/storage/history';

export interface HistoryListProps {
  /** Newest-first, as returned by `readHistory` — not re-sorted here. */
  runs: SyncRun[];
}

/** null only when no account in the run has a computed imported count. */
function totalImported(run: SyncRun): number | null {
  const counted = run.accounts.filter((a) => a.imported !== null);
  if (counted.length === 0) return null;
  return counted.reduce((sum, a) => sum + (a.imported as number), 0);
}

function failureCount(run: SyncRun): number {
  return run.accounts.filter((a) => a.error !== null).length;
}

export function HistoryList({ runs }: HistoryListProps) {
  if (runs.length === 0) return null;

  return (
    <Table aria-label="Sync history">
      <TableHeader>
        <TableRow>
          <TableHead>Run</TableHead>
          <TableHead>Imported</TableHead>
          <TableHead>Failures</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => {
          const imported = totalImported(run);
          return (
            <TableRow key={run.startedAt}>
              <TableCell>{new Date(run.startedAt).toLocaleString()}</TableCell>
              <TableCell>{imported === null ? '—' : imported}</TableCell>
              <TableCell>{failureCount(run)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
