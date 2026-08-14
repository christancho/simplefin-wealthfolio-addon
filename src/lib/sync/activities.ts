import type { AccountType, ActivityImport, HostAPI } from '@wealthfolio/addon-sdk';
import type { SfAccount, SfTransaction } from '../simplefin/parse';
import type { AccountMapping } from '../storage/config';
import { advanceWatermark, shouldPush, type Watermark } from '../storage/watermark';

/** Epoch seconds -> YYYY-MM-DD in UTC, the form Wealthfolio's importer expects. */
export function isoDate(epochSeconds: number): string {
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
  destinationAccountType: AccountType,
): ActivityImport {
  const isOutflow = txn.amount.trim().startsWith('-');
  const magnitude = txn.amount.trim().replace(/^-/, '');
  // The host rejects DEPOSIT outright on a CREDIT_CARD account
  // ("DEPOSIT activities are not supported for credit card accounts",
  // confirmed against a live host) — CREDIT is the type it accepts for
  // money landing on a card.
  const inflowType = destinationAccountType === 'CREDIT_CARD' ? 'CREDIT' : 'DEPOSIT';

  return {
    accountId: mapping.wfAccountId,
    activityType: isOutflow ? 'WITHDRAWAL' : inflowType,
    date: isoDate(txn.posted),
    amount: magnitude,
    currency,
    // Cash activities have no ticker. The addon-sdk types this as optional,
    // but the host's import endpoint deserializes it as a required field and
    // rejects the whole batch with an instant 422 if it's absent — confirmed
    // against a live host (SDK 3.6.2 vs host 3.6.3 version skew).
    symbol: '',
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
  accountType: AccountType,
  paymentKeywords: string[],
): Promise<{ result: CashSyncCounts; watermark: Watermark; candidates: never[] }> {
  // Pending transactions are excluded from v1: their id and amount can both
  // change once posted, which would push a row we could never reconcile.
  const candidates = sfAccount.transactions.filter((t) => !t.pending && shouldPush(watermark, t));

  if (candidates.length === 0) {
    return { result: { imported: 0, skipped: 0, duplicates: 0 }, watermark, candidates: [] };
  }

  const rows = candidates.map((t) => toActivityImport(t, mapping, sfAccount.currency, accountType));
  let checked;
  try {
    checked = await api.activities.checkImport(rows);
  } catch (error) {
    // A rejection here means the host rejected the request itself (e.g. a
    // required field the addon-sdk types don't yet reflect) rather than
    // flagging individual rows — log the payload so the mismatch is visible.
    api.logger.error(
      `[simplefin] activities.checkImport rejected ${rows.length} row(s) for ` +
        `${mapping.sfAccountName}: ${JSON.stringify(rows)}`,
    );
    throw error;
  }

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
    return { result: { imported: 0, skipped, duplicates }, watermark: advanced, candidates: [] };
  }

  let outcome;
  try {
    outcome = await api.activities.import(importable);
  } catch (error) {
    // `checkImport` marked these rows valid, so a rejection here means the
    // host's import-time validation caught something checkImport didn't —
    // log the exact payload so the failing field is visible next run instead
    // of just the bare HTTP status text.
    api.logger.error(
      `[simplefin] activities.import rejected ${importable.length} row(s) for ` +
        `${mapping.sfAccountName}: ${JSON.stringify(importable)}`,
    );
    throw error;
  }

  return {
    result: { imported: outcome.summary.imported, skipped, duplicates },
    // Only advance over what was actually accepted — if the import throws, this
    // line is never reached and the watermark stays put, so the next run retries.
    watermark: advanceWatermark(watermark, importableTxns),
    candidates: [],
  };
}
