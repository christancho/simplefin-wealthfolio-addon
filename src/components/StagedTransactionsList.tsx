import type { Account, ActivityDetails, HostAPI } from '@wealthfolio/addon-sdk';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatAmount,
} from '@wealthfolio/ui';
import { Fragment, useEffect, useState } from 'react';
import { describeWithdrawals, findBackfillCandidates, resolveAmbiguous, runReconciliation } from '../lib/sync/reconciliation';
import { readStaging, writeStaging, type StagedCandidate } from '../lib/storage/staging';
import { compactCellClassName, compactHeadClassName } from './tableStyle';

const COLUMN_COUNT = 6;

function candidateTypeLabel(candidate: StagedCandidate): string {
  return candidate.inflowActivityType === 'DEPOSIT' ? 'Cash transfer' : 'Card payment';
}

/** Groups candidates by their inflow account (credit card or cash), preserving first-seen order. */
function groupByInflowAccount(candidates: StagedCandidate[]): [string, StagedCandidate[]][] {
  const groups = new Map<string, StagedCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.inflowAccountId) ?? [];
    group.push(candidate);
    groups.set(candidate.inflowAccountId, group);
  }
  return [...groups.entries()];
}

export interface StagedTransactionsListProps {
  api: HostAPI;
  cashAccountIds: string[];
  cardAccountIds: string[];
  paymentKeywords: string[];
  transferKeywords: string[];
  wfAccounts: Account[];
}

export function StagedTransactionsList({
  api,
  cashAccountIds,
  cardAccountIds,
  paymentKeywords,
  transferKeywords,
  wfAccounts,
}: StagedTransactionsListProps) {
  const [candidates, setCandidates] = useState<StagedCandidate[] | null>(null);
  const [resolving, setResolving] = useState<StagedCandidate | null>(null);
  const [choices, setChoices] = useState<ActivityDetails[]>([]);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  async function load() {
    try {
      setCandidates(await readStaging(api));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function dismiss(target: StagedCandidate) {
    const next = (candidates ?? []).filter((c) => c.sfTransactionId !== target.sfTransactionId);
    setCandidates(next);
    try {
      await writeStaging(api, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openResolve(candidate: StagedCandidate) {
    setError(null);
    setResolving(candidate);
    setChosenId(null);
    try {
      setChoices(await describeWithdrawals(api, cashAccountIds, candidate.candidateWithdrawalIds));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function confirmResolve() {
    if (!resolving || !chosenId) return;
    try {
      await resolveAmbiguous(api, resolving, cashAccountIds, chosenId);
      const next = (candidates ?? []).filter((c) => c.sfTransactionId !== resolving.sfTransactionId);
      setCandidates(next);
      await writeStaging(api, next);
      setResolving(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function scanForOlderPayments() {
    setError(null);
    setScanning(true);
    try {
      const existing = await readStaging(api);
      const found = await findBackfillCandidates(api, cardAccountIds, paymentKeywords, cashAccountIds, transferKeywords, existing);
      const { candidates: remaining } = await runReconciliation(
        api,
        [...existing, ...found],
        cashAccountIds,
        Math.floor(Date.now() / 1000),
      );
      setCandidates(remaining);
      await writeStaging(api, remaining);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }

  const scanButton = (
    <Button size="sm" variant="outline" onClick={scanForOlderPayments} disabled={scanning}>
      {scanning ? 'Scanning…' : 'Scan for older payments and transfers'}
    </Button>
  );

  if (candidates === null) {
    return (
      <>
        {scanButton}
        {error && <p className="text-destructive text-sm">{error}</p>}
      </>
    );
  }
  if (candidates.length === 0) {
    return (
      <>
        {scanButton}
        {error && <p className="text-destructive text-sm">{error}</p>}
        <p className="text-muted-foreground text-sm">No staged transactions.</p>
      </>
    );
  }

  return (
    <>
      {scanButton}
      {error && <p className="text-destructive text-sm">{error}</p>}
      <Table aria-label="Staged transactions">
        <TableHeader>
          <TableRow>
            <TableHead className={compactHeadClassName}>Date</TableHead>
            <TableHead className={compactHeadClassName}>Comment</TableHead>
            <TableHead className={compactHeadClassName}>Type</TableHead>
            <TableHead className={compactHeadClassName}>Status</TableHead>
            <TableHead className={compactHeadClassName}>Amount</TableHead>
            <TableHead className={compactHeadClassName}>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groupByInflowAccount(candidates).map(([inflowAccountId, group]) => {
            const accountName = wfAccounts.find((a) => a.id === inflowAccountId)?.name ?? inflowAccountId;
            return (
              <Fragment key={inflowAccountId}>
                <TableRow>
                  <TableCell className={compactCellClassName} colSpan={COLUMN_COUNT}>
                    {`${accountName} (${group.length})`}
                  </TableCell>
                </TableRow>
                {group.map((candidate) => (
                  <TableRow key={candidate.sfTransactionId}>
                    <TableCell className={compactCellClassName}>{candidate.postedDate}</TableCell>
                    <TableCell className={compactCellClassName}>{candidate.comment}</TableCell>
                    <TableCell className={compactCellClassName}>{candidateTypeLabel(candidate)}</TableCell>
                    <TableCell className={compactCellClassName}>{candidate.status}</TableCell>
                    <TableCell className={compactCellClassName}>{formatAmount(candidate.amount, candidate.currency)}</TableCell>
                    <TableCell className={compactCellClassName}>
                      <div className="flex gap-2">
                        {candidate.status === 'ambiguous' && (
                          <Button size="sm" onClick={() => openResolve(candidate)}>
                            Resolve
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => dismiss(candidate)}>
                          Dismiss
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
      <Dialog open={resolving !== null} onOpenChange={(open) => !open && setResolving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pick the matching withdrawal</DialogTitle>
          </DialogHeader>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Table aria-label="Matching withdrawals">
            <TableHeader>
              <TableRow>
                <TableHead className={compactHeadClassName} />
                <TableHead className={compactHeadClassName}>Account</TableHead>
                <TableHead className={compactHeadClassName}>Description</TableHead>
                <TableHead className={compactHeadClassName}>Date</TableHead>
                <TableHead className={compactHeadClassName}>Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {choices.map((choice) => (
                <TableRow
                  key={choice.id}
                  className="cursor-pointer"
                  onClick={() => setChosenId(choice.id)}
                >
                  <TableCell className={compactCellClassName}>
                    <input
                      type="radio"
                      name="withdrawal-choice"
                      value={choice.id}
                      checked={chosenId === choice.id}
                      onChange={() => setChosenId(choice.id)}
                      aria-label={`Select ${choice.accountName} — ${choice.comment}`}
                    />
                  </TableCell>
                  <TableCell className={compactCellClassName}>{choice.accountName}</TableCell>
                  <TableCell className={compactCellClassName}>{choice.comment}</TableCell>
                  <TableCell className={compactCellClassName}>{new Date(choice.date).toISOString().slice(0, 10)}</TableCell>
                  <TableCell className={compactCellClassName}>{formatAmount(choice.amount, choice.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <DialogFooter>
            <Button onClick={confirmResolve} disabled={!chosenId}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
