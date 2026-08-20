import type { Account, HostAPI } from '@wealthfolio/addon-sdk';
import { cn, formatAmount, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@wealthfolio/ui';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { AccountMapping, SyncMode } from '../lib/storage/config';
import type { SfAccount } from '../lib/simplefin/parse';
import { CreateAccountDialog } from './CreateAccountDialog';
import { nativeSelectClassName } from './nativeSelectStyle';
import { compactCellClassName, compactHeadClassName } from './tableStyle';

const CREATE_OPTION = '__create__';
const COLUMN_COUNT = 5;

/** Groups accounts by institution, preserving first-seen order. */
function groupByInstitution(sfAccounts: SfAccount[]): [string, SfAccount[]][] {
  const groups = new Map<string, SfAccount[]>();
  for (const sfAccount of sfAccounts) {
    const group = groups.get(sfAccount.orgName) ?? [];
    group.push(sfAccount);
    groups.set(sfAccount.orgName, group);
  }
  return [...groups.entries()];
}

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
  const [collapsedOrgs, setCollapsedOrgs] = useState<Set<string>>(new Set());

  function toggleOrg(orgName: string) {
    setCollapsedOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(orgName)) {
        next.delete(orgName);
      } else {
        next.add(orgName);
      }
      return next;
    });
  }

  function mappingFor(sfAccountId: string) {
    return mappings.find((m) => m.sfAccountId === sfAccountId);
  }

  /** A Wealthfolio account already mapped to a different SimpleFIN account is not a valid target. */
  function availableWfAccounts(sfAccountId: string) {
    const takenElsewhere = new Set(
      mappings.filter((m) => m.sfAccountId !== sfAccountId).map((m) => m.wfAccountId),
    );
    return wfAccounts.filter((a) => !takenElsewhere.has(a.id));
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
            <TableHead className={compactHeadClassName}>Account</TableHead>
            <TableHead className={compactHeadClassName}>Currency</TableHead>
            <TableHead className={cn(compactHeadClassName, 'text-right')}>Balance</TableHead>
            <TableHead className={compactHeadClassName}>Wealthfolio account</TableHead>
            <TableHead className={compactHeadClassName}>Sync mode</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groupByInstitution(sfAccounts).map(([orgName, accounts]) => {
            const collapsed = collapsedOrgs.has(orgName);
            return (
              <Fragment key={orgName}>
                <TableRow>
                  <TableCell className={compactCellClassName} colSpan={COLUMN_COUNT}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 text-left font-medium"
                      aria-expanded={!collapsed}
                      onClick={() => toggleOrg(orgName)}
                    >
                      {collapsed ? (
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      ) : (
                        <ChevronDown className="h-4 w-4 shrink-0" />
                      )}
                      {orgName}
                      <span className="text-muted-foreground font-normal">({accounts.length})</span>
                    </button>
                  </TableCell>
                </TableRow>
                {!collapsed &&
                  accounts.map((sfAccount) => {
                    const mapping = mappingFor(sfAccount.id);
                    return (
                      <TableRow key={sfAccount.id}>
                        <TableCell className={cn(compactCellClassName, 'pl-9')}>{sfAccount.name}</TableCell>
                        <TableCell className={compactCellClassName}>{sfAccount.currency}</TableCell>
                        <TableCell className={cn(compactCellClassName, 'text-right tabular-nums')}>
                          {formatAmount(sfAccount.balance, sfAccount.currency)}
                        </TableCell>
                        <TableCell className={compactCellClassName}>
                          <select
                            aria-label={`Map ${sfAccount.name}`}
                            className={nativeSelectClassName}
                            value={mapping?.wfAccountId ?? ''}
                            onChange={(e) => handleSelectChange(sfAccount, e.target.value)}
                          >
                            <option value="">Unmapped</option>
                            {availableWfAccounts(sfAccount.id).map((wfAccount) => (
                              <option key={wfAccount.id} value={wfAccount.id}>
                                {wfAccount.name}
                              </option>
                            ))}
                            <option value={CREATE_OPTION}>+ Create new account…</option>
                          </select>
                        </TableCell>
                        <TableCell className={compactCellClassName}>
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
              </Fragment>
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
