import type { Account, HostAPI } from '@wealthfolio/addon-sdk';
import { Alert, AlertDescription, Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@wealthfolio/ui';
import { useEffect, useState } from 'react';
import { AccountMapTable } from '../components/AccountMapTable';
import { BridgeErrorBanner } from '../components/BridgeErrorBanner';
import { HistoryList } from '../components/HistoryList';
import { SettingsPanel } from '../components/SettingsPanel';
import { SetupCard } from '../components/SetupCard';
import { SyncSummary } from '../components/SyncSummary';
import { fetchAccounts } from '../lib/simplefin/client';
import type { SfAccount } from '../lib/simplefin/parse';
import { bridgeDashboardUrl } from '../lib/simplefin/url';
import { readConfig, writeConfig, type AccountMapping, type SyncConfig } from '../lib/storage/config';
import { readHistory, type SyncRun } from '../lib/storage/history';
import { runSync } from '../lib/sync/run';

export interface SyncPageProps {
  api: HostAPI;
}

export function SyncPage({ api }: SyncPageProps) {
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [sfAccounts, setSfAccounts] = useState<SfAccount[]>([]);
  const [wfAccounts, setWfAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<SyncRun | null>(null);
  const [history, setHistory] = useState<SyncRun[]>([]);

  async function loadConfig() {
    try {
      setConfig(await readConfig(api));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!config?.baseUrl) return;
    const baseUrl = config.baseUrl;

    setError(null);
    Promise.all([fetchAccounts(api.network, baseUrl, {}), api.accounts.getAll(), readHistory(api)])
      .then(([{ accounts }, wfAccountList, historyList]) => {
        setSfAccounts(accounts);
        setWfAccounts(wfAccountList);
        setHistory(historyList);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.baseUrl]);

  async function handleSync() {
    if (!config?.baseUrl) return;
    setSyncing(true);
    setSyncError(null);
    try {
      const run = await runSync(api, config);
      setLastRun(run);
      setHistory(await readHistory(api));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      api.logger.error(`[simplefin] sync failed: ${message}`);
      setSyncError(message);
    } finally {
      setSyncing(false);
    }
  }

  async function persistMappings(mappings: AccountMapping[]) {
    if (!config) return;
    const previous = config;
    const next = { ...config, mappings };
    setConfig(next);
    try {
      await writeConfig(api, next);
    } catch (err) {
      setConfig(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function persistLookbackDays(lookbackDays: number) {
    if (!config) return;
    const previous = config;
    const next = { ...config, lookbackDays };
    setConfig(next);
    try {
      await writeConfig(api, next);
    } catch (err) {
      setConfig(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!config) {
    return error ? (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    ) : null;
  }

  if (!config.baseUrl) {
    return <SetupCard api={api} onConnected={loadConfig} />;
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {lastRun && (
        <BridgeErrorBanner errors={lastRun.bridgeErrors} dashboardUrl={bridgeDashboardUrl(config.baseUrl)} />
      )}
      <Tabs defaultValue="accounts" orientation="vertical" className="flex items-start gap-4">
        <div className="flex w-40 shrink-0 flex-col gap-2">
          <TabsList className="flex h-fit flex-col items-stretch gap-1">
            <TabsTrigger value="accounts" className="justify-start">
              Accounts
            </TabsTrigger>
            <TabsTrigger value="summary" className="justify-start">
              Summary
            </TabsTrigger>
            <TabsTrigger value="runs" className="justify-start">
              Runs
            </TabsTrigger>
            <TabsTrigger value="settings" className="justify-start">
              Settings
            </TabsTrigger>
          </TabsList>
          <Button onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync now'}
          </Button>
          {syncError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{syncError}</AlertDescription>
            </Alert>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <TabsContent value="accounts" className="mt-0">
            <AccountMapTable
              api={api}
              sfAccounts={sfAccounts}
              wfAccounts={wfAccounts}
              mappings={config.mappings}
              onChange={persistMappings}
              onAccountCreated={(account) => setWfAccounts((prev) => [...prev, account])}
            />
          </TabsContent>
          <TabsContent value="summary" className="mt-0">
            {lastRun ? (
              <SyncSummary run={lastRun} />
            ) : (
              <p className="text-muted-foreground text-sm">Run a sync to see results.</p>
            )}
          </TabsContent>
          <TabsContent value="runs" className="mt-0">
            <HistoryList runs={history} />
          </TabsContent>
          <TabsContent value="settings" className="mt-0">
            <SettingsPanel
              api={api}
              baseUrl={config.baseUrl}
              lookbackDays={config.lookbackDays}
              onLookbackDaysChange={persistLookbackDays}
              onDisconnected={loadConfig}
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
