import type { ActivityImport, HostAPI } from '@wealthfolio/addon-sdk';
import type { SfAccount, SfTransaction } from '../simplefin/parse';
import type { AccountMapping } from '../storage/config';
import { advanceWatermark, shouldPush, type Watermark } from '../storage/watermark';

/** Epoch seconds -> YYYY-MM-DD in UTC, the form Wealthfolio's importer expects. */
function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * SimpleFIN signs amounts (negative = money out); Wealthfolio splits direction
 * into the activity type and expects a positive magnitude. The string is kept
 * as a string throughout — parsing to a float would round real money.
 */
export function toActivityImport(
  txn: SfTransaction,
  mapping: AccountMapping,
  currency: string,
): ActivityImport {
  const isOutflow = txn.amount.trim().startsWith('-');
  const magnitude = txn.amount.trim().replace(/^-/, '');

  return {
    accountId: mapping.wfAccountId,
    activityType: isOutflow ? 'WITHDRAWAL' : 'DEPOSIT',
    date: isoDate(txn.posted),
    amount: magnitude,
    currency,
    comment: txn.payee || txn.description,
    isValid: true,
    isDraft: false,
  };
}

export interface CashSyncCounts {
  imported: number;
  skipped: number;
  duplicates: number;
}

export async function syncCashAccount(
  api: HostAPI,
  mapping: AccountMapping,
  sfAccount: SfAccount,
  watermark: Watermark,
): Promise<{ result: CashSyncCounts; watermark: Watermark }> {
  // Pending transactions are excluded from v1: their id and amount can both
  // change once posted, which would push a row we could never reconcile.
  const candidates = sfAccount.transactions.filter((t) => !t.pending && shouldPush(watermark, t));

  if (candidates.length === 0) {
    return { result: { imported: 0, skipped: 0, duplicates: 0 }, watermark };
  }

  const rows = candidates.map((t) => toActivityImport(t, mapping, sfAccount.currency));
  const checked = await api.activities.checkImport(rows);

  // checkImport annotates each row. Host-detected duplicates are a secondary
  // guard behind our own watermark; we never force-import over them.
  const importable: ActivityImport[] = [];
  const importableTxns: SfTransaction[] = [];
  let duplicates = 0;
  let skipped = 0;

  checked.forEach((row, index) => {
    if (row.duplicateOfId || row.duplicateOfLineNumber !== undefined) {
      duplicates += 1;
      return;
    }
    if (!row.isValid) {
      skipped += 1;
      api.logger.error(
        `[simplefin] row rejected by checkImport for ${mapping.sfAccountName}: ` +
          JSON.stringify(row.errors ?? {}),
      );
      return;
    }
    importable.push(row);
    importableTxns.push(candidates[index]);
  });

  if (importable.length === 0) {
    // Rows duplicating an activity Wealthfolio already holds (`duplicateOfId`)
    // are genuinely present on the other side, so the watermark may advance
    // over them — otherwise every run re-checks the same rows forever. Rows
    // flagged only by `duplicateOfLineNumber` duplicate another row in *this*
    // batch, which was itself never imported here, so those must not advance.
    const advanced = advanceWatermark(
      watermark,
      candidates.filter((_, i) => checked[i].duplicateOfId),
    );
    return { result: { imported: 0, skipped, duplicates }, watermark: advanced };
  }

  const outcome = await api.activities.import(importable);

  return {
    result: { imported: outcome.summary.imported, skipped, duplicates },
    // Only advance over what was actually accepted — if the import throws, this
    // line is never reached and the watermark stays put, so the next run retries.
    watermark: advanceWatermark(watermark, importableTxns),
  };
}
