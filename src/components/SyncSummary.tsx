import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@wealthfolio/ui';
import type { AccountRunResult, SyncRun } from '../lib/storage/history';

export interface SyncSummaryProps {
  run: SyncRun;
}

function cell(value: number | null): string {
  return value === null ? '—' : String(value);
}

/** null unless every count that feeds it was actually computed. */
function totalFor(result: AccountRunResult): number | null {
  const { imported, skipped, duplicates } = result;
  if (imported === null || skipped === null || duplicates === null) return null;
  return imported + skipped + duplicates;
}

export function SyncSummary({ run }: SyncSummaryProps) {
  return (
    <Table aria-label="Sync results">
      <TableHeader>
        <TableRow>
          <TableHead>Account</TableHead>
          <TableHead>Imported</TableHead>
          <TableHead>Skipped</TableHead>
          <TableHead>Duplicates</TableHead>
          <TableHead>Total</TableHead>
          <TableHead>Balance</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {run.accounts.map((result) => (
          <TableRow key={result.sfAccountId}>
            <TableCell>{result.sfAccountName}</TableCell>
            {result.error ? (
              <TableCell colSpan={5}>Failed: {result.error}</TableCell>
            ) : (
              <>
                <TableCell>{cell(result.imported)}</TableCell>
                <TableCell>{cell(result.skipped)}</TableCell>
                <TableCell>{cell(result.duplicates)}</TableCell>
                <TableCell>{cell(totalFor(result))}</TableCell>
                <TableCell>
                  {result.balanceMismatch
                    ? `SimpleFIN ${result.balanceMismatch.simplefin} vs Wealthfolio ${result.balanceMismatch.wealthfolio}`
                    : '—'}
                </TableCell>
              </>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
