import type { HostAPI } from '@wealthfolio/addon-sdk';
import { fetchAccounts } from '../simplefin/client';
import type { SfAccount } from '../simplefin/parse';
import type { AccountMapping, SyncConfig } from '../storage/config';
import { appendRun, type AccountRunResult, type SyncRun } from '../storage/history';
import { readWatermark, writeWatermark } from '../storage/watermark';
import { syncCashAccount } from './activities';
import { compareBalances } from './balance';
import { syncHoldingsAccount } from './snapshots';

/**
 * Re-fetch overlap. The Bridge can post a transaction days after its posted
 * date, so each run asks for a window before the watermark and relies on the
 * recent-id set to discard what we already pushed.
 */
const OVERLAP_DAYS = 7;
const SECONDS_PER_DAY = 86_400;

async function syncOne(
  api: HostAPI,
  mapping: AccountMapping,
  sfAccount: SfAccount | undefined,
  wfBalances: Map<string, string>,
): Promise<AccountRunResult> {
  const base: AccountRunResult = {
    sfAccountId: mapping.sfAccountId,
    sfAccountName: mapping.sfAccountName,
    orgName: mapping.orgName,
    wfAccountId: mapping.wfAccountId,
    mode: mapping.mode,
    imported: null,
    skipped: null,
    duplicates: null,
    error: null,
    balanceMismatch: null,
  };

  if (!sfAccount) {
    return {
      ...base,
      error:
        `SimpleFIN account ${mapping.sfAccountId} was not returned by the Bridge. ` +
        'It may have been disconnected — re-check the mapping.',
    };
  }

  try {
    if (mapping.mode === 'HOLDINGS') {
      const { imported, skipped } = await syncHoldingsAccount(api, mapping, sfAccount);
      return {
        ...base,
        imported,
        skipped,
        duplicates: 0,
        balanceMismatch: compareBalances(
          sfAccount.balance,
          wfBalances.get(mapping.wfAccountId) ?? null,
        ),
      };
    }

    const watermark = await readWatermark(api, mapping.sfAccountId);
    const { result, watermark: next } = await syncCashAccount(api, mapping, sfAccount, watermark);
    await writeWatermark(api, mapping.sfAccountId, next);

    return {
      ...base,
      imported: result.imported,
      skipped: result.skipped,
      duplicates: result.duplicates,
      balanceMismatch: compareBalances(
        sfAccount.balance,
        wfBalances.get(mapping.wfAccountId) ?? null,
      ),
    };
  } catch (error) {
    // Per-institution isolation is a hard invariant: record and continue.
    const message = error instanceof Error ? error.message : String(error);
    api.logger.error(`[simplefin] account ${mapping.sfAccountName} failed: ${message}`);
    return { ...base, error: message };
  }
}

export async function runSync(api: HostAPI, config: SyncConfig): Promise<SyncRun> {
  if (!config.baseUrl) {
    throw new Error('Not connected to SimpleFIN — claim a setup token first.');
  }

  const startedAt = new Date().toISOString();

  // One fetch covers every account; the Bridge bills per call, and a single
  // response also lets one institution's error surface alongside healthy data.
  // The window starts at the oldest watermark so no account is short-changed.
  const watermarks = await Promise.all(
    config.mappings.map((m) => readWatermark(api, m.sfAccountId)),
  );
  const oldest = watermarks.reduce(
    (min, wm) => (wm.lastPosted > 0 && wm.lastPosted < min ? wm.lastPosted : min),
    Number.POSITIVE_INFINITY,
  );
  const startDate = Number.isFinite(oldest)
    ? Math.max(0, oldest - OVERLAP_DAYS * SECONDS_PER_DAY)
    : undefined;

  const { accounts, errors } = await fetchAccounts(api.network, config.baseUrl, {
    startDate,
    accountIds: config.mappings.map((m) => m.sfAccountId),
  });

  const bySfId = new Map(accounts.map((a) => [a.id, a]));

  // Wealthfolio balances for the post-sync mismatch check. A failure here must
  // not fail the run — the check is diagnostic, so it degrades to "unavailable".
  const wfBalances = new Map<string, string>();
  try {
    for (const account of await api.accounts.getAll()) {
      if (Number.isFinite(account.balance)) wfBalances.set(account.id, String(account.balance));
    }
  } catch (error) {
    api.logger.error(
      `[simplefin] could not read Wealthfolio balances for the mismatch check: ${String(error)}`,
    );
  }

  // Sequential on purpose: the host import APIs are shared state, and a serial
  // run keeps one slow institution from being blamed for another's timeout.
  const results: AccountRunResult[] = [];
  for (const mapping of config.mappings) {
    results.push(await syncOne(api, mapping, bySfId.get(mapping.sfAccountId), wfBalances));
  }

  const run: SyncRun = {
    startedAt,
    finishedAt: new Date().toISOString(),
    accounts: results,
    bridgeErrors: errors,
  };

  await appendRun(api, run);
  return run;
}
