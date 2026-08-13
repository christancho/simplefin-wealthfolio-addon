import type { Account, HostAPI } from '@wealthfolio/addon-sdk';
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@wealthfolio/ui';
import { useState } from 'react';
import { KEY_PREFIX } from '../lib/constants';
import type { SfAccount } from '../lib/simplefin/parse';
import { nativeSelectClassName } from './nativeSelectStyle';

export interface CreateAccountDialogProps {
  api: HostAPI;
  sfAccount: SfAccount;
  onOpenChange: (open: boolean) => void;
  onCreated: (account: Account) => void;
}

type AccountTypeValue = Account['accountType'];
type TrackingMode = Account['trackingMode'];

// `AccountType` is declared in the SDK's .d.ts but the compiled package
// never emits it as a runtime value, so the option list is spelled out here.
const ACCOUNT_TYPES: AccountTypeValue[] = [
  'SECURITIES',
  'CASH',
  'CREDIT_CARD',
  'CRYPTOCURRENCY',
];

function deriveDraft(sfAccount: SfAccount) {
  const hasHoldings = sfAccount.holdings.length > 0;
  return {
    name: `${sfAccount.orgName} ${sfAccount.name}`.trim(),
    currency: sfAccount.currency,
    accountType: (hasHoldings ? 'SECURITIES' : 'CASH') as AccountTypeValue,
    trackingMode: (hasHoldings ? 'HOLDINGS' : 'TRANSACTIONS') as TrackingMode,
  };
}

export function CreateAccountDialog({
  api,
  sfAccount,
  onOpenChange,
  onCreated,
}: CreateAccountDialogProps) {
  const [draft, setDraft] = useState(() => deriveDraft(sfAccount));
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    setError(null);
    setCreating(true);
    try {
      const account = await api.accounts.create({
        name: draft.name,
        currency: draft.currency,
        accountType: draft.accountType,
        trackingMode: draft.trackingMode,
        provider: KEY_PREFIX,
        providerAccountId: sfAccount.id,
        // The backend's create endpoint requires these even though they're
        // normally server-computed; the addon-sdk's Account type doesn't
        // surface that its `create()` payload diverges from its response shape.
        isDefault: false,
        isActive: true,
      });
      onCreated(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Wealthfolio account</DialogTitle>
          <DialogDescription>
            This account will be linked to {sfAccount.orgName} {sfAccount.name}.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-account-name">Name</Label>
            <Input
              id="new-account-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              disabled={creating}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-account-currency">Currency</Label>
            <Input
              id="new-account-currency"
              value={draft.currency}
              onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
              disabled={creating}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-account-type">Account type</Label>
            <select
              id="new-account-type"
              className={nativeSelectClassName}
              value={draft.accountType}
              onChange={(e) =>
                setDraft({ ...draft, accountType: e.target.value as AccountTypeValue })
              }
              disabled={creating}
            >
              {ACCOUNT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-account-tracking">Tracking mode</Label>
            <select
              id="new-account-tracking"
              className={nativeSelectClassName}
              value={draft.trackingMode}
              onChange={(e) =>
                setDraft({ ...draft, trackingMode: e.target.value as TrackingMode })
              }
              disabled={creating}
            >
              <option value="TRANSACTIONS">Transactions</option>
              <option value="HOLDINGS">Holdings</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleCreate} disabled={creating || !draft.name.trim()}>
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
