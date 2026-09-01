import type { AccountType, ActivityImport, HostAPI } from '@wealthfolio/addon-sdk';
import type { SfAccount, SfTransaction } from '../simplefin/parse';
import type { AccountMapping } from '../storage/config';
import type { InflowActivityType, StagedCandidate } from '../storage/staging';
import { advanceWatermark, shouldPush, type Watermark } from '../storage/watermark';

/** Epoch seconds -> YYYY-MM-DD in UTC. Addon-internal only — never sent to the host. */
export function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Epoch seconds -> full RFC3339 instant, the form every activity `date` must
 * take on the wire.
 *
 * Never send a bare `YYYY-MM-DD`: Wealthfolio's deserializer expands a
 * date-only value to *midnight UTC* (`activities_model.rs`,
 * `timestamp_format::deserialize`), which its frontend then renders in the
 * viewer's local zone — showing 8:00 PM the previous day in America/Toronto.
 * Passing the instant through lets the host localize the real moment. The
 * Bridge encodes its own date-only values at noon UTC, the timezone-safe
 * midpoint, so the calendar date survives localization in either direction.
 */
export function isoInstant(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/**
 * Normalises a host-returned activity date (typed `Date`, serialised as an
 * ISO string over JSON — confirmed against a live host) down to a comparable
 * `YYYY-MM-DD`.
 *
 * Deliberately UTC, and every date-bucket comparison in this addon must stay
 * UTC on *both* sides so they agree: a candidate's `postedDate` from
 * `isoDate()` and a host row's date through this function are the two halves
 * of the same comparison. The Bridge's noon-UTC encoding means the UTC bucket
 * is the intended calendar date; an institution reporting real intraday
 * timestamps could bucket a late-evening local purchase into the next UTC day,
 * which would shift the reconciliation match window by a day for that row.
 * That is latent — no such institution has been observed — and re-bucketing to
 * local time would strand every `postedDate` already persisted in staging, so
 * the UTC invariant stands until a real timestamp feed forces the migration.
 */
export function toIsoDateOnly(dateLike: unknown): string {
  return new Date(dateLike as string | Date).toISOString().slice(0, 10);
}

/**
 * Which instant dates an activity: `transacted_at` when the Bridge reports it,
 * `posted` otherwise.
 *
 * `posted` is when the bank settled the transaction, often 1-3 days after the
 * purchase; `transacted_at` is when it actually happened, which is what a user
 * comparing against their statement expects to see. The watermark deliberately
 * keeps using `posted` (see `../storage/watermark`) — that is the Bridge's own
 * ordering key for what it has released, and is unrelated to how a row is
 * dated.
 */
export function activityEpoch(txn: Pick<SfTransaction, 'posted' | 'transactedAt'>): number {
  return txn.transactedAt ?? txn.posted;
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
    date: isoInstant(activityEpoch(txn)),
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

/** Case-insensitive substring match against a configured keyword list. */
export function isPaymentCandidate(text: string, keywords: string[]): boolean {
  const upper = text.toUpperCase();
  return keywords.some((keyword) => keyword.trim() !== '' && upper.includes(keyword.toUpperCase()));
}

/**
 * An inflow transaction (`CREDIT` on a credit-card account, or `DEPOSIT` on a
 * plain cash account) whose payee/comment looks like a bill payment or an
 * internal transfer becomes a staged candidate for TRANSFER_IN/OUT
 * reconciliation (see `./reconciliation.ts`). Returns null for anything that
 * doesn't match — normal purchases, paychecks, and unrelated credits are left
 * untouched.
 */
export function detectCandidate(
  txn: SfTransaction,
  mapping: AccountMapping,
  keywords: string[],
  inflowActivityType: InflowActivityType,
  currency: string,
): StagedCandidate | null {
  const text = txn.payee || txn.description;
  if (!isPaymentCandidate(text, keywords)) return null;

  return {
    sfTransactionId: txn.id,
    inflowAccountId: mapping.wfAccountId,
    inflowActivityId: null,
    inflowActivityType,
    amount: txn.amount.trim().replace(/^-/, ''),
    currency,
    postedDate: isoDate(activityEpoch(txn)),
    comment: text,
    status: 'pending',
    candidateWithdrawalIds: [],
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
  transferKeywords: string[],
): Promise<{
  result: CashSyncCounts;
  watermark: Watermark;
  candidates: StagedCandidate[];
  importedTxns: SfTransaction[];
}> {
  // Pending transactions are excluded from v1: their id and amount can both
  // change once posted, which would push a row we could never reconcile.
  const candidates = sfAccount.transactions.filter((t) => !t.pending && shouldPush(watermark, t));

  if (candidates.length === 0) {
    return {
      result: { imported: 0, skipped: 0, duplicates: 0 },
      watermark,
      candidates: [],
      importedTxns: [],
    };
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
    return {
      result: { imported: 0, skipped, duplicates },
      watermark: advanced,
      candidates: [],
      importedTxns: [],
    };
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

  // The host reports what landed as counts, not per-row status, so a short
  // batch can't be narrowed to *which* rows failed. Advancing the watermark
  // over a batch we can't account for would skip the missing rows forever, and
  // counting them in `importedTxns` would shrink the opening-balance plug by
  // money that never landed. Failing the account instead leaves the watermark
  // untouched (the caller writes it only on a clean return), so the next run
  // retries the whole batch — the rows that did land come back from
  // `checkImport` as `duplicateOfId` and advance the watermark then.
  //
  // Host-side duplicates count as landed for the same reason they do above:
  // the row is genuinely present on the other side.
  const landed = outcome.summary.imported + outcome.summary.duplicates;
  if (!outcome.summary.success || landed < importable.length) {
    throw new Error(
      `activities.import landed ${landed} of ${importable.length} row(s) for ` +
        `${mapping.sfAccountName} (success=${outcome.summary.success}, ` +
        `imported=${outcome.summary.imported}, duplicates=${outcome.summary.duplicates}, ` +
        `skipped=${outcome.summary.skipped}) — watermark held back for a retry next run`,
    );
  }

  // Only an inflow (money landing on the account) is ever scanned for
  // keywords — the withdrawal/purchase leg is never turned into a candidate
  // itself, only matched against one. Which keyword list and inflow activity
  // type applies depends on what kind of account this is: a credit-card
  // CREDIT is checked against paymentKeywords, a plain cash account's DEPOSIT
  // against transferKeywords.
  const inflowTxns = importableTxns.filter((t) => !t.amount.trim().startsWith('-'));
  const stagedCandidates =
    accountType === 'CREDIT_CARD'
      ? inflowTxns
          .map((t) => detectCandidate(t, mapping, paymentKeywords, 'CREDIT', sfAccount.currency))
          .filter((c): c is StagedCandidate => c !== null)
      : inflowTxns
          .map((t) => detectCandidate(t, mapping, transferKeywords, 'DEPOSIT', sfAccount.currency))
          .filter((c): c is StagedCandidate => c !== null);

  return {
    result: { imported: outcome.summary.imported, skipped, duplicates },
    // Only advance over what was actually accepted — if the import throws, this
    // line is never reached and the watermark stays put, so the next run retries.
    watermark: advanceWatermark(watermark, importableTxns),
    candidates: stagedCandidates,
    importedTxns: importableTxns,
  };
}
