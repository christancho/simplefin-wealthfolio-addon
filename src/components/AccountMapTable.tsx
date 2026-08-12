import type { Account, HostAPI } from '@wealthfolio/addon-sdk';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@wealthfolio/ui';
import { useState } from 'react';
import type { AccountMapping, SyncMode } from '../lib/storage/config';
import type { SfAccount } from '../lib/simplefin/parse';
import { CreateAccountDialog } from './CreateAccountDialog';
import { nativeSelectClassName } from './nativeSelectStyle';

const CREATE_OPTION = '__create__';

export interface AccountMapTableProps {
  api: HostAPI;
  sfAccounts: SfAccount[];
  wfAccounts: Account[];
  mappings: AccountMapping[];
  onChange: (mappings: AccountMapping[]) => void;
  onAccountCreated: (account: Account) => void;
}

function defaultModeFor(sfAccount: SfAccount): SyncMode {
  return sfAccount.holdings.length > 0 ? 'HOLDINGS' : 'CASH';
}

export function AccountMapTable({
  api,
  sfAccounts,
  wfAccounts,
  mappings,
  onChange,
  onAccountCreated,
}: AccountMapTableProps) {
  const [creatingFor, setCreatingFor] = useState<SfAccount | null>(null);

  function mappingFor(sfAccountId: string) {
    return mappings.find((m) => m.sfAccountId === sfAccountId);
  }

  function upsertMapping(sfAccount: SfAccount, wfAccountId: string) {
    const existing = mappingFor(sfAccount.id);
    const next: AccountMapping = {
      sfAccountId: sfAccount.id,
      wfAccountId,
      mode: existing?.mode ?? defaultModeFor(sfAccount),
      sfAccountName: sfAccount.name,
      orgName: sfAccount.orgName,
    };
    onChange([...mappings.filter((m) => m.sfAccountId !== sfAccount.id), next]);
  }

  function handleSelectChange(sfAccount: SfAccount, value: string) {
    if (value === CREATE_OPTION) {
      setCreatingFor(sfAccount);
      return;
    }
    if (value === '') {
      onChange(mappings.filter((m) => m.sfAccountId !== sfAccount.id));
      return;
    }
    upsertMapping(sfAccount, value);
  }

  function handleModeChange(sfAccount: SfAccount, mode: SyncMode) {
    const existing = mappingFor(sfAccount.id);
    if (!existing) return;
    onChange(mappings.map((m) => (m.sfAccountId === sfAccount.id ? { ...m, mode } : m)));
  }

  function handleAccountCreated(sfAccount: SfAccount, account: Account) {
    onAccountCreated(account);
    upsertMapping(sfAccount, account.id);
    setCreatingFor(null);
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Institution</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>Currency</TableHead>
            <TableHead>Balance</TableHead>
            <TableHead>Wealthfolio account</TableHead>
            <TableHead>Sync mode</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sfAccounts.map((sfAccount) => {
            const mapping = mappingFor(sfAccount.id);
            return (
              <TableRow key={sfAccount.id}>
                <TableCell>{sfAccount.orgName}</TableCell>
                <TableCell>{sfAccount.name}</TableCell>
                <TableCell>{sfAccount.currency}</TableCell>
                <TableCell>{sfAccount.balance}</TableCell>
                <TableCell>
                  <select
                    aria-label={`Map ${sfAccount.name}`}
                    className={nativeSelectClassName}
                    value={mapping?.wfAccountId ?? ''}
                    onChange={(e) => handleSelectChange(sfAccount, e.target.value)}
                  >
                    <option value="">Unmapped</option>
                    {wfAccounts.map((wfAccount) => (
                      <option key={wfAccount.id} value={wfAccount.id}>
                        {wfAccount.name}
                      </option>
                    ))}
                    <option value={CREATE_OPTION}>+ Create new account…</option>
                  </select>
                </TableCell>
                <TableCell>
                  <select
                    aria-label={`Sync mode for ${sfAccount.name}`}
                    className={nativeSelectClassName}
                    value={mapping?.mode ?? defaultModeFor(sfAccount)}
                    onChange={(e) => handleModeChange(sfAccount, e.target.value as SyncMode)}
                    disabled={!mapping}
                  >
                    <option value="CASH">Cash</option>
                    <option value="HOLDINGS">Holdings</option>
                  </select>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {creatingFor && (
        <CreateAccountDialog
          api={api}
          sfAccount={creatingFor}
          onOpenChange={(open) => !open && setCreatingFor(null)}
          onCreated={(account) => handleAccountCreated(creatingFor, account)}
        />
      )}
    </>
  );
}
