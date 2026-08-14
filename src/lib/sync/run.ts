import type { AccountType, HostAPI } from '@wealthfolio/addon-sdk';
import { fetchAccounts } from '../simplefin/client';
import type { SfAccount } from '../simplefin/parse';
import type { AccountMapping, SyncConfig } from '../storage/config';
import { appendRun, type AccountRunResult, type SyncRun } from '../storage/history';
import { readWatermark, writeWatermark } from '../storage/watermark';
import { syncCashAccount } from './activities';
import { compareBalances } from './balance';
import { buildOpeningBalanceActivity } from './openingBalance';
import { syncHoldingsAccount } from './snapshots';

/**
 * Re-fetch overlap. The Bridge can post a transaction days after its posted
 * date, so each run asks for a window before the watermark and relies on the
 * recent-id set to discard what we already pushed.
 */
const OVERLAP_DAYS = 7;
const SECONDS_PER_DAY = 86_400;

/**
 * Full-history pull for a CASH mapping's first-ever sync. The shared batch
 * fetch in runSync is deliberately windowed (lookbackDays), so a fresh
 * mapping never gets more than one statement cycle from it — this is the
 * separate, per-account counterpart that asks for everything the Bridge is
 * willing to give, so the opening-balance plug below has as little gap as
 * possible left to cover. An explicit epoch-0 startDate is used rather than
 * omitting the param: the SimpleFIN spec treats an omitted start-date as
 * bridge-implementation-defined, not a documented "give me everything".
 */
async function fetchFullHistory(
  api: HostAPI,
  baseUrl: string,
  sfAccountId: string,
): Promise<SfAccount | undefined> {
  const { accounts } = await fetchAccounts(api.network, baseUrl, {
    accountIds: [sfAccountId],
    startDate: 0,
  });
  return accounts.find((a) => a.id === sfAccountId);
}

/**
 * Plugs the gap between SimpleFIN's current balance and whatever the
 * full-history pull actually landed in Wealthfolio, as one synthetic
 * TRANSFER_IN/OUT activity. The gap is read from Wealthfolio's real balance
 * after the push rather than tracked through the batch import's return value
 * — `ImportActivitiesResult.summary` only carries counts, not which rows
 * landed or their amounts, and diffing the account's actual balance sidesteps
 * needing that: a retry after a partial failure just recomputes against
 * whatever is really there, so a gap already closed comes out as zero and is
 * skipped rather than double-plugged.
 */
async function pushOpeningBalance(
  api: HostAPI,
  mapping: AccountMapping,
  sfAccount: SfAccount,
): Promise<number> {
  await api.portfolio.recalculate();
  const wfAccount = (await api.accounts.getAll()).find((a) => a.id === mapping.wfAccountId);
  if (!wfAccount) return 0;

  const posted = sfAccount.transactions.filter((t) => !t.pending);
  const earliestPosted = posted.length > 0 ? Math.min(...posted.map((t) => t.posted)) : null;

  const plug = buildOpeningBalanceActivity(
    {
      sfBalance: sfAccount.balance,
      wfBalance: String(wfAccount.balance),
      earliestPosted,
      balanceDate: sfAccount.balanceDate,
    },
    mapping,
    sfAccount.currency,
  );
  if (!plug) return 0;

  const [checked] = await api.activities.checkImport([plug]);
  if (!checked.isValid || checked.duplicateOfId) return 0;

  await api.activities.import([checked]);
  return 1;
}

async function syncOne(
  api: HostAPI,
  baseUrl: string,
  mapping: AccountMapping,
  sfAccount: SfAccount | undefined,
  wfBalances: Map<string, string>,
  wfAccountTypes: Map<string, AccountType>,
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
    const isFirstSync = watermark.lastPosted === 0;

    // A fresh mapping never has enough in the shared, lookbackDays-windowed
    // batch fetch to seed an accurate opening balance — pull this one
    // account's full history separately before pushing anything.
    const syncSfAccount = isFirstSync
      ? ((await fetchFullHistory(api, baseUrl, mapping.sfAccountId)) ?? sfAccount)
      : sfAccount;

    const { result, watermark: next } = await syncCashAccount(
      api,
      mapping,
      syncSfAccount,
      watermark,
      wfAccountTypes.get(mapping.wfAccountId) ?? 'CASH',
      [],
    );
    await writeWatermark(api, mapping.sfAccountId, next);

    const plugImported = isFirstSync ? await pushOpeningBalance(api, mapping, syncSfAccount) : 0;

    return {
      ...base,
      imported: result.imported + plugImported,
      skipped: result.skipped,
      duplicates: result.duplicates,
      // A first-sync account's balance was just brought into agreement by the
      // plug above (or never disagreed); comparing against the pre-run
      // snapshot in wfBalances would flag a stale, misleading mismatch.
      balanceMismatch: isFirstSync
        ? null
        : compareBalances(sfAccount.balance, wfBalances.get(mapping.wfAccountId) ?? null),
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
  const oldestWatermark = watermarks.reduce(
    (min, wm) => (wm.lastPosted > 0 && wm.lastPosted < min ? wm.lastPosted : min),
    Number.POSITIVE_INFINITY,
  );
  const watermarkFloor = oldestWatermark - OVERLAP_DAYS * SECONDS_PER_DAY;

  // A mapping added after its sibling accounts already have recent watermarks
  // would otherwise inherit their (much later) shared start date and never
  // get its own history. `lookbackDays` guarantees every sync reaches back at
  // least that far, regardless of what the other accounts' watermarks say.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const lookbackFloor = nowSeconds - config.lookbackDays * SECONDS_PER_DAY;

  const startDate = Math.max(0, Math.min(watermarkFloor, lookbackFloor));

  const { accounts, errors } = await fetchAccounts(api.network, config.baseUrl, {
    startDate,
    accountIds: config.mappings.map((m) => m.sfAccountId),
  });

  const bySfId = new Map(accounts.map((a) => [a.id, a]));

  // Wealthfolio balances for the post-sync mismatch check. A failure here must
  // not fail the run — the check is diagnostic, so it degrades to "unavailable".
  const wfBalances = new Map<string, string>();
  const wfAccountTypes = new Map<string, AccountType>();
  try {
    for (const account of await api.accounts.getAll()) {
      if (Number.isFinite(account.balance)) wfBalances.set(account.id, String(account.balance));
      wfAccountTypes.set(account.id, account.accountType);
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
    results.push(
      await syncOne(api, config.baseUrl, mapping, bySfId.get(mapping.sfAccountId), wfBalances, wfAccountTypes),
    );
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
