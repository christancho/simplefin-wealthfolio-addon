import { cn, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@wealthfolio/ui';
import type { AccountRunResult, SyncRun } from '../lib/storage/history';
import { compactCellClassName, compactHeadClassName } from './tableStyle';

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
          <TableHead className={compactHeadClassName}>Account</TableHead>
          <TableHead className={cn(compactHeadClassName, 'text-right')}>Imported</TableHead>
          <TableHead className={cn(compactHeadClassName, 'text-right')}>Skipped</TableHead>
          <TableHead className={cn(compactHeadClassName, 'text-right')}>Duplicates</TableHead>
          <TableHead className={cn(compactHeadClassName, 'text-right')}>Total</TableHead>
          <TableHead className={compactHeadClassName}>Balance</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {run.accounts.map((result) => (
          <TableRow key={result.sfAccountId}>
            <TableCell className={compactCellClassName}>{result.sfAccountName}</TableCell>
            {result.error ? (
              <TableCell className={compactCellClassName} colSpan={5}>
                Failed: {result.error}
              </TableCell>
            ) : (
              <>
                <TableCell className={cn(compactCellClassName, 'text-right tabular-nums')}>
                  {cell(result.imported)}
                </TableCell>
                <TableCell className={cn(compactCellClassName, 'text-right tabular-nums')}>
                  {cell(result.skipped)}
                </TableCell>
                <TableCell className={cn(compactCellClassName, 'text-right tabular-nums')}>
                  {cell(result.duplicates)}
                </TableCell>
                <TableCell className={cn(compactCellClassName, 'text-right tabular-nums')}>
                  {cell(totalFor(result))}
                </TableCell>
                <TableCell className={compactCellClassName}>
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
