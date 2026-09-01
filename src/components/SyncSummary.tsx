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

/**
 * A skipped balance check must never read like a passing one. `—` is reserved
 * for runs recorded before `balanceUnchecked` existed, where `undefined` means
 * the outcome genuinely isn't known.
 */
function balanceLabel(result: AccountRunResult): string {
  if (result.balanceMismatch) {
    return `SimpleFIN ${result.balanceMismatch.simplefin} vs Wealthfolio ${result.balanceMismatch.wealthfolio}`;
  }
  if (result.balanceUnchecked === undefined) return '—';
  if (result.balanceUnchecked !== null) return `Not checked — ${result.balanceUnchecked}`;
  return 'Matches';
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
            <TableCell className={compactCellClassName}>
              {result.sfAccountName}
              {/* A caveat on a result that did sync — never suppresses the counts,
                  unlike `error`, which means the account produced nothing. */}
              {result.warning ? (
                <div className="text-muted-foreground text-xs">Warning: {result.warning}</div>
              ) : null}
            </TableCell>
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
                <TableCell className={compactCellClassName}>{balanceLabel(result)}</TableCell>
              </>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
