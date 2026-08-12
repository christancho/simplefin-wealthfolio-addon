import type { Account, HostAPI } from '@wealthfolio/addon-sdk';
import { Alert, AlertDescription } from '@wealthfolio/ui';
import { useEffect, useState } from 'react';
import { AccountMapTable } from '../components/AccountMapTable';
import { SetupCard } from '../components/SetupCard';
import { fetchAccounts } from '../lib/simplefin/client';
import type { SfAccount } from '../lib/simplefin/parse';
import { readConfig, writeConfig, type AccountMapping, type SyncConfig } from '../lib/storage/config';

export interface SyncPageProps {
  api: HostAPI;
}

export function SyncPage({ api }: SyncPageProps) {
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [sfAccounts, setSfAccounts] = useState<SfAccount[]>([]);
  const [wfAccounts, setWfAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);

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
    Promise.all([fetchAccounts(api.network, baseUrl, {}), api.accounts.getAll()])
      .then(([{ accounts }, wfAccountList]) => {
        setSfAccounts(accounts);
        setWfAccounts(wfAccountList);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.baseUrl]);

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
      <AccountMapTable
        api={api}
        sfAccounts={sfAccounts}
        wfAccounts={wfAccounts}
        mappings={config.mappings}
        onChange={persistMappings}
        onAccountCreated={(account) => setWfAccounts((prev) => [...prev, account])}
      />
    </div>
  );
}
