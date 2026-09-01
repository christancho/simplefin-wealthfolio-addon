export interface SfTransaction {
  id: string;
  /** Epoch seconds, as the Bridge reports it — when the bank *settled* the transaction. */
  posted: number;
  /**
   * Epoch seconds for when the purchase actually happened, null when the
   * Bridge doesn't report it. The protocol marks `transacted_at` optional and
   * only guarantees `posted`, which can trail it by 1-3 days — see
   * `activityEpoch` in `../sync/activities` for which one dates an activity.
   */
  transactedAt: number | null;
  /** Signed decimal string; negative means money out. Never parsed to a number. */
  amount: string;
  description: string;
  payee: string | null;
  memo: string | null;
  pending: boolean;
}

export interface SfHolding {
  symbol: string;
  shares: string | null;
  currency: string | null;
  costBasis: string | null;
  purchasePrice: string | null;
  marketValue: string | null;
}

export interface SfAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;
  /** Epoch seconds. */
  balanceDate: number;
  orgName: string;
  transactions: SfTransaction[];
  holdings: SfHolding[];
}

export interface SfBridgeError {
  code: string;
  msg: string;
  connId: string | null;
  accountId: string | null;
  /**
   * Stable identity for deduping the same institution failure across runs.
   * conn_id/account_id are the durable handles when present; msg is the
   * last-resort key for legacy entries that carry neither.
   */
  key: string;
}

function str(value: unknown, fallback = ''): string {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

/**
 * Absent, null, blank, or non-numeric all mean "the Bridge didn't report it".
 * So does a non-positive epoch: 0 is a plausible "unknown" sentinel, and
 * taking it literally would date the activity to 1970 instead of falling back
 * to `posted`.
 */
function optNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function optStr(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function parseTransaction(raw: Record<string, unknown>): SfTransaction {
  return {
    id: str(raw.id),
    posted: Number(raw.posted),
    transactedAt: optNum(raw.transacted_at),
    amount: str(raw.amount),
    description: str(raw.description),
    payee: optStr(raw.payee),
    memo: optStr(raw.memo),
    pending: Boolean(raw.pending),
  };
}

function parseHolding(raw: Record<string, unknown>): SfHolding {
  return {
    symbol: str(raw.symbol),
    shares: optStr(raw.shares),
    currency: optStr(raw.currency),
    costBasis: optStr(raw.cost_basis),
    purchasePrice: optStr(raw.purchase_price),
    marketValue: optStr(raw.market_value),
  };
}

function parseAccount(raw: Record<string, unknown>): SfAccount {
  const org = (raw.org ?? {}) as Record<string, unknown>;
  const transactions = Array.isArray(raw.transactions) ? raw.transactions : [];
  const holdings = Array.isArray(raw.holdings) ? raw.holdings : [];

  return {
    id: str(raw.id),
    name: str(raw.name),
    currency: str(raw.currency),
    balance: str(raw.balance),
    balanceDate: Number(raw['balance-date']),
    orgName: str(org.name) || str(org.domain),
    transactions: transactions.map((t) => parseTransaction(t as Record<string, unknown>)),
    holdings: holdings.map((h) => parseHolding(h as Record<string, unknown>)),
  };
}

function parseErrors(payload: Record<string, unknown>): SfBridgeError[] {
  const errlist = payload.errlist;

  if (Array.isArray(errlist) && errlist.length > 0) {
    return errlist.map((entry) => {
      const e = entry as Record<string, unknown>;
      const code = str(e.code);
      const msg = str(e.msg);
      const connId = optStr(e.conn_id);
      const accountId = optStr(e.account_id);
      return { code, msg, connId, accountId, key: `${code}:${connId ?? accountId ?? msg}` };
    });
  }

  const legacy = Array.isArray(payload.errors) ? payload.errors : [];
  return legacy.map((msg) => ({
    code: 'legacy',
    msg: String(msg),
    connId: null,
    accountId: null,
    key: `legacy:${String(msg)}`,
  }));
}

export function parseAccountsResponse(payload: unknown): {
  accounts: SfAccount[];
  errors: SfBridgeError[];
} {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('SimpleFIN returned a payload that is not an object');
  }

  const body = payload as Record<string, unknown>;
  const rawAccounts = Array.isArray(body.accounts) ? body.accounts : [];

  return {
    accounts: rawAccounts.map((a) => parseAccount(a as Record<string, unknown>)),
    errors: parseErrors(body),
  };
}
