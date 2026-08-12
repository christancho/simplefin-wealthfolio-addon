import type { HostAPI, SnapshotInput } from '@wealthfolio/addon-sdk';
import type { SfAccount } from '../simplefin/parse';
import type { AccountMapping } from '../storage/config';

/** Epoch seconds -> YYYY-MM-DD in UTC, the form Wealthfolio's importer expects. */
function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function toSnapshotInput(sfAccount: SfAccount): SnapshotInput {
  const positions = sfAccount.holdings
    // A position with no symbol or no share count cannot be resolved to a
    // Wealthfolio asset; sending it would fail validation for the whole batch.
    .filter((h) => h.symbol !== '' && h.shares !== null)
    .map((h) => ({
      symbol: h.symbol,
      quantity: h.shares as string,
      avgCost: h.purchasePrice ?? undefined,
      currency: h.currency ?? sfAccount.currency,
    }));

  return {
    date: isoDate(sfAccount.balanceDate),
    positions,
    cashBalances: { [sfAccount.currency]: sfAccount.balance },
  };
}

export async function syncHoldingsAccount(
  api: HostAPI,
  mapping: AccountMapping,
  sfAccount: SfAccount,
): Promise<{ imported: number; skipped: number }> {
  if (sfAccount.holdings.length === 0) {
    return { imported: 0, skipped: 0 };
  }

  const snapshot = toSnapshotInput(sfAccount);
  const check = await api.snapshots.checkImport(mapping.wfAccountId, [snapshot]);

  if (check.validationErrors.length > 0) {
    throw new Error(`snapshot rejected: ${check.validationErrors.join('; ')}`);
  }

  // `existingDates` is the host-side idempotency signal — holdings need no
  // local watermark because re-importing a known date is detectable here.
  if (check.existingDates.includes(snapshot.date)) {
    return { imported: 0, skipped: 1 };
  }

  const outcome = await api.snapshots.importSnapshots(mapping.wfAccountId, [snapshot]);

  if (outcome.errors.length > 0) {
    throw new Error(`snapshot import failed: ${outcome.errors.join('; ')}`);
  }

  return { imported: outcome.snapshotsImported, skipped: 0 };
}
