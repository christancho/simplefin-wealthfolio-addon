# SimpleFIN Wealthfolio Addon v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Wealthfolio addon that syncs SimpleFIN Bridge cash transactions and investment holdings into Wealthfolio on a manual "Sync now" trigger, with per-institution failure isolation and no separate service.

**Architecture:** A single ESM bundle (`dist/addon.js`) loaded by Wealthfolio's addon host. All I/O goes through the addon's `HostAPI`: the SimpleFIN Bridge is reached via brokered `api.network.request()` (credentials resolved host-side from `api.secrets` by key, never in the request), Wealthfolio writes go through `api.activities.checkImport()/.import()` and `api.snapshots.checkImport()/.importSnapshots()`, and all durable addon state lives in `api.storage`. Because `ActivityImport` cannot carry `sourceSystem`/`sourceRecordId`, cash-transaction idempotency is owned by the addon via a per-account watermark plus a bounded recent-id window.

**Tech Stack:** TypeScript 5.9, React 19.2, Vite 7, Vitest 3, `@wealthfolio/addon-sdk@3.6.2`, `@wealthfolio/ui@^3.6.0`, `@tanstack/react-query@^5.90`, Tailwind CSS 4.

## Global Constraints

- **Addon id:** `simplefin-sync`. This exact string is the manifest `id`, the `contributes.routes[].id`, the runtime `ctx.router.add({ id })`, and the route path segment `/addons/simplefin-sync`. All four must match.
- **SDK version:** `sdkVersion` and `minWealthfolioVersion` are both `"3.6.2"` in `manifest.json`.
- **Never call `createRoot`.** The host owns a single React root per addon and mounts the route `component` itself. Calling `createRoot` leaves orphaned trees whose re-renders never reach the DOM (the 3.6 "buttons do nothing" bug). Register routes with `component:`, not `render:`. The SDK's published README still shows the old `createRoot` pattern — it is stale; ignore it and follow `dist/src/types.d.ts`.
- **No react-router hooks.** The sandbox has no router provider. `useLocation()`/`useParams()` will fail. The host passes the current location as a `location` prop to the route component.
- **Host-provided dependencies must never be bundled.** These are externalized in `vite.config.ts` and declared in manifest `hostDependencies`, at exactly these versions: `@tanstack/react-query@^5.90.0`, `@wealthfolio/addon-sdk@^3.6.2`, `@wealthfolio/ui@^3.6.0`, `date-fns@^4.1.0`, `lucide-react@^0.561.0`, `react@^19.2.0`, `react-dom@^19.2.0`, `recharts@^3.7.0`.
- **`api.storage` limits:** keys ≤128 chars from the charset `[A-Za-z0-9_.:-]`; values capped at ~250 KB each. Use many small keys, never one large blob. `localStorage` is unavailable (sandboxed opaque-origin iframe) — never reach for it.
- **Secrets never enter `storage` or logs.** The SimpleFIN access URL embeds credentials. Only the base64 `user:pass` goes to `api.secrets`; only the credential-stripped base URL goes to `api.storage`. Never log either.
- **Per-institution failure isolation** is a hard invariant: one failing account or institution must never prevent the others from syncing. Every per-account operation is individually caught and recorded.
- **No hardcoded numeric values** (project rule). Thresholds and computed figures derive from real data or are named constants with a stated rationale; if a value can't be computed, return `null`.
- **No silent error handlers** (project rule 2). Every `catch` either re-throws, logs via `ctx.api.logger.error` with source attribution, or records into the run result the UI renders.
- **Pending transactions are skipped** — v1 imports posted transactions only.
- **Money is handled as strings**, never JS `number`. `ActivityImport.amount` accepts `string`; SimpleFIN returns decimal strings. Parsing to float would introduce rounding error in financial data.

---

## File Structure

```
manifest.json              — addon id, permissions, network.allowedHosts, contributes, hostDependencies
vite.config.ts             — lib build to dist/addon.js, host deps externalized
vitest.config.ts           — jsdom environment, test globs
tsconfig.json              — TS 5.9 strict, react-jsx
src/addon.tsx              — enable() entry: captures ctx, registers route + sidebar
src/lib/simplefin/url.ts   — access-URL parsing, credential split, dashboard URL
src/lib/simplefin/claim.ts — setup-token → access URL exchange
src/lib/simplefin/client.ts— brokered GET /accounts, query building
src/lib/simplefin/parse.ts — Bridge JSON → typed Account/Transaction/Holding/BridgeError
src/lib/storage/keys.ts    — storage key namespacing + charset validation
src/lib/storage/config.ts  — account mapping read/write
src/lib/storage/watermark.ts— per-account watermark + recent-id window
src/lib/storage/history.ts — sync run history (bounded ring)
src/lib/sync/activities.ts — transactions → ActivityImport, checkImport/import
src/lib/sync/snapshots.ts  — holdings → SnapshotInput, checkImport/importSnapshots
src/lib/sync/run.ts        — orchestration, per-account isolation, run summary
src/lib/sync/balance.ts    — post-sync balance mismatch check
src/pages/SyncPage.tsx     — route root: setup / mapping / sync / history
src/components/*.tsx       — SetupCard, AccountMapTable, SyncSummary, BridgeErrorBanner, HistoryList
```

---

### Task 1: Scaffold, build, and test harness

**Files:**
- Create: whole project skeleton (see below)
- Test: `src/lib/__tests__/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a building addon with `pnpm build` → `dist/addon.js`, `pnpm test` → Vitest green, and `ADDON_ID = 'simplefin-sync'` exported from `src/lib/constants.ts`.

- [ ] **Step 1: Generate the skeleton with the official scaffolder**

Run from the repo root. The scaffolder writes the current (3.6.2) templates, including the correct non-`createRoot` route pattern:

```bash
npx --yes @wealthfolio/addon-dev-tools@3.6.2 create simplefin-sync
```

If `create` prompts interactively, answer: name `simplefin-sync`, description `Sync SimpleFIN Bridge accounts into Wealthfolio`, author `christancho`. If it creates a nested `simplefin-sync/` directory, move its contents to the repo root and remove the empty directory — the addon lives at the repo root, not in a subfolder.

- [ ] **Step 2: Verify the generated entry point does NOT call createRoot**

Run: `grep -n "createRoot" src/addon.tsx`
Expected: matches appear only inside comments (the template warns against it). If any live code calls `createRoot`, replace the route registration with the `component:` form shown in the Global Constraints before continuing.

- [ ] **Step 3: Add Vitest**

```bash
pnpm add -D vitest@^3 jsdom@^25 @testing-library/react@^16 @testing-library/jest-dom@^6
```

Create `vitest.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

Add to `package.json` scripts:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Create the shared constant**

Create `src/lib/constants.ts`:

```ts
/** Must match manifest `id`, `contributes.routes[].id`, and the route path segment. */
export const ADDON_ID = 'simplefin-sync';

/** Storage/secret key prefix. Charset is constrained to [A-Za-z0-9_.:-] by the host. */
export const KEY_PREFIX = 'simplefin';
```

- [ ] **Step 5: Write the smoke test**

Create `src/lib/__tests__/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ADDON_ID } from '../constants';

describe('addon constants', () => {
  it('exposes the canonical addon id', () => {
    expect(ADDON_ID).toBe('simplefin-sync');
  });
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test`
Expected: PASS, 1 test.

- [ ] **Step 7: Configure the manifest**

Edit `manifest.json` so `id`, `sdkVersion`, `minWealthfolioVersion`, `network`, and `permissions` are exactly:

```json
{
  "id": "simplefin-sync",
  "name": "SimpleFIN Sync",
  "version": "1.0.0",
  "description": "Sync bank, credit-card and investment data from SimpleFIN Bridge into Wealthfolio.",
  "main": "dist/addon.js",
  "sdkVersion": "3.6.2",
  "minWealthfolioVersion": "3.6.2",
  "network": {
    "allowedHosts": ["bridge.simplefin.org", "beta-bridge.simplefin.org"]
  },
  "permissions": [
    {
      "category": "network",
      "functions": [{ "name": "request", "isDeclared": true, "isDetected": false }],
      "purpose": "Fetch accounts, transactions and holdings from the SimpleFIN Bridge."
    },
    {
      "category": "secrets",
      "functions": [
        { "name": "set", "isDeclared": true, "isDetected": false },
        { "name": "get", "isDeclared": true, "isDetected": false },
        { "name": "delete", "isDeclared": true, "isDetected": false }
      ],
      "purpose": "Store the SimpleFIN access credentials in the system keyring."
    },
    {
      "category": "accounts",
      "functions": [
        { "name": "getAll", "isDeclared": true, "isDetected": false },
        { "name": "create", "isDeclared": true, "isDetected": false }
      ],
      "purpose": "List Wealthfolio accounts to map against, and create new ones on request."
    },
    {
      "category": "activities",
      "functions": [
        { "name": "checkImport", "isDeclared": true, "isDetected": false },
        { "name": "import", "isDeclared": true, "isDetected": false }
      ],
      "purpose": "Import cash transactions fetched from SimpleFIN."
    },
    {
      "category": "snapshots",
      "functions": [
        { "name": "checkImport", "isDeclared": true, "isDetected": false },
        { "name": "importSnapshots", "isDeclared": true, "isDetected": false }
      ],
      "purpose": "Import holdings snapshots for investment accounts."
    }
  ]
}
```

Do **not** declare `storage`, `logger`, `toast`, `ui`, or `query` — these are baseline capabilities (`BASELINE_PERMISSION_CATEGORIES`) and declaring them is ignored.

- [ ] **Step 8: Verify the build**

Run: `pnpm build`
Expected: `dist/addon.js` written, no bundling of react/react-dom (check with `grep -c "react" dist/addon.js` — imports should be bare `from "react"` specifiers, not inlined source).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: scaffold addon skeleton with vitest harness"
```

---

### Task 2: Access-URL parsing and credential handling

**Files:**
- Create: `src/lib/simplefin/url.ts`
- Test: `src/lib/simplefin/url.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `splitAccessUrl(accessUrl: string): { baseUrl: string; basicAuthSecret: string }` — `baseUrl` is credential-free with no trailing slash; `basicAuthSecret` is base64 of `user:pass`, the exact form `NetworkAuth` with `type: 'basic'` requires.
  - `bridgeDashboardUrl(baseUrl: string): string` — scheme + host only.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/simplefin/url.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bridgeDashboardUrl, splitAccessUrl } from './url';

describe('splitAccessUrl', () => {
  it('separates credentials from the base URL', () => {
    const { baseUrl, basicAuthSecret } = splitAccessUrl(
      'https://alice:s3cret@bridge.simplefin.org/simplefin',
    );
    expect(baseUrl).toBe('https://bridge.simplefin.org/simplefin');
    expect(basicAuthSecret).toBe(btoa('alice:s3cret'));
  });

  it('strips a trailing slash so path joining is unambiguous', () => {
    const { baseUrl } = splitAccessUrl('https://a:b@bridge.simplefin.org/simplefin/');
    expect(baseUrl).toBe('https://bridge.simplefin.org/simplefin');
  });

  it('preserves percent-encoded credentials', () => {
    const { basicAuthSecret } = splitAccessUrl(
      'https://user%40x.com:p%3Ass@bridge.simplefin.org/simplefin',
    );
    expect(basicAuthSecret).toBe(btoa('user@x.com:p:ss'));
  });

  it('rejects a URL with no credentials', () => {
    expect(() => splitAccessUrl('https://bridge.simplefin.org/simplefin')).toThrow(
      /credentials/i,
    );
  });

  it('rejects a non-https URL', () => {
    expect(() => splitAccessUrl('http://a:b@bridge.simplefin.org/simplefin')).toThrow(
      /https/i,
    );
  });
});

describe('bridgeDashboardUrl', () => {
  it('reduces to scheme and host', () => {
    expect(bridgeDashboardUrl('https://bridge.simplefin.org/simplefin')).toBe(
      'https://bridge.simplefin.org',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/simplefin/url.test.ts`
Expected: FAIL — cannot resolve `./url`.

- [ ] **Step 3: Implement**

Create `src/lib/simplefin/url.ts`:

```ts
/**
 * A SimpleFIN access URL embeds credentials: https://user:pass@host/path
 *
 * The brokered network API never accepts inline credentials — it resolves them
 * host-side from the secret store via `NetworkAuth.secretKey`. So we split the
 * URL once, at claim time: the credential-free base goes to `storage`, and the
 * base64 `user:pass` (the exact form `NetworkAuth` with type 'basic' expects)
 * goes to `secrets`.
 */
export interface SplitAccessUrl {
  baseUrl: string;
  basicAuthSecret: string;
}

export function splitAccessUrl(accessUrl: string): SplitAccessUrl {
  const url = new URL(accessUrl.trim());

  if (url.protocol !== 'https:') {
    throw new Error('SimpleFIN access URL must use https');
  }
  if (!url.username) {
    throw new Error('SimpleFIN access URL is missing credentials');
  }

  // URL getters keep credentials percent-encoded; the Bridge issues them
  // encoded, and basic auth is defined over the decoded bytes.
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);

  url.username = '';
  url.password = '';

  const baseUrl = url.toString().replace(/\/+$/, '');

  return { baseUrl, basicAuthSecret: btoa(`${user}:${pass}`) };
}

/**
 * The Bridge management dashboard. There is no documented per-connection deep
 * link, so the general dashboard is the honest target for a "fix this" link.
 */
export function bridgeDashboardUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/simplefin/url.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/simplefin/url.ts src/lib/simplefin/url.test.ts
git commit -m "feat: split SimpleFIN access URL into base URL and basic-auth secret"
```

---

### Task 3: Bridge response parsing

**Files:**
- Create: `src/lib/simplefin/parse.ts`
- Test: `src/lib/simplefin/parse.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:

```ts
export interface SfTransaction {
  id: string; posted: number; amount: string; description: string;
  payee: string | null; memo: string | null; pending: boolean;
}
export interface SfHolding {
  symbol: string; shares: string | null; currency: string | null;
  costBasis: string | null; purchasePrice: string | null; marketValue: string | null;
}
export interface SfAccount {
  id: string; name: string; currency: string; balance: string;
  balanceDate: number; orgName: string;
  transactions: SfTransaction[]; holdings: SfHolding[];
}
export interface SfBridgeError {
  code: string; msg: string; connId: string | null; accountId: string | null; key: string;
}
export function parseAccountsResponse(payload: unknown):
  { accounts: SfAccount[]; errors: SfBridgeError[] };
```

`posted` and `balanceDate` stay as epoch seconds (numbers) — they are timestamps, not money. All money fields stay strings.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/simplefin/parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseAccountsResponse } from './parse';

const payload = {
  errors: [],
  accounts: [
    {
      org: { name: 'Test Bank', domain: 'testbank.com' },
      id: 'ACT-1',
      name: 'Checking',
      currency: 'USD',
      balance: '1234.56',
      'balance-date': 1754524800,
      transactions: [
        {
          id: 'TXN-1',
          posted: 1754438400,
          amount: '-42.10',
          description: 'COFFEE',
          payee: 'Blue Bottle',
          memo: null,
        },
        { id: 'TXN-2', posted: 1754524800, amount: '2000.00', description: 'SALARY', pending: true },
      ],
      holdings: [],
    },
  ],
};

describe('parseAccountsResponse', () => {
  it('parses accounts and keeps money as strings', () => {
    const { accounts } = parseAccountsResponse(payload);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].balance).toBe('1234.56');
    expect(typeof accounts[0].balance).toBe('string');
    expect(accounts[0].orgName).toBe('Test Bank');
    expect(accounts[0].balanceDate).toBe(1754524800);
  });

  it('preserves transaction sign and pending flag', () => {
    const [account] = parseAccountsResponse(payload).accounts;
    expect(account.transactions[0].amount).toBe('-42.10');
    expect(account.transactions[0].pending).toBe(false);
    expect(account.transactions[1].pending).toBe(true);
  });

  it('falls back to org domain when name is absent', () => {
    const { accounts } = parseAccountsResponse({
      accounts: [{ ...payload.accounts[0], org: { domain: 'testbank.com' } }],
    });
    expect(accounts[0].orgName).toBe('testbank.com');
  });

  it('prefers structured errlist over the deprecated flat errors array', () => {
    const { errors } = parseAccountsResponse({
      accounts: [],
      errors: ['legacy message'],
      errlist: [{ code: 'AUTH', msg: 'Reauthenticate Test Bank', conn_id: 'C1' }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('AUTH');
    expect(errors[0].key).toBe('AUTH:C1');
  });

  it('wraps a legacy flat errors array when errlist is absent', () => {
    const { errors } = parseAccountsResponse({ accounts: [], errors: ['boom'] });
    expect(errors[0].code).toBe('legacy');
    expect(errors[0].msg).toBe('boom');
    expect(errors[0].key).toBe('legacy:boom');
  });

  it('throws on a payload that is not an object', () => {
    expect(() => parseAccountsResponse('nope')).toThrow(/payload/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/simplefin/parse.test.ts`
Expected: FAIL — cannot resolve `./parse`.

- [ ] **Step 3: Implement**

Create `src/lib/simplefin/parse.ts`:

```ts
export interface SfTransaction {
  id: string;
  /** Epoch seconds, as the Bridge reports it. */
  posted: number;
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

function optStr(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function parseTransaction(raw: Record<string, unknown>): SfTransaction {
  return {
    id: str(raw.id),
    posted: Number(raw.posted),
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/simplefin/parse.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/simplefin/parse.ts src/lib/simplefin/parse.test.ts
git commit -m "feat: parse SimpleFIN accounts response with structured bridge errors"
```

---

### Task 4: Brokered Bridge client and token claim

**Files:**
- Create: `src/lib/simplefin/client.ts`, `src/lib/simplefin/claim.ts`
- Create: `src/test/mockHost.ts` (shared HostAPI test double)
- Test: `src/lib/simplefin/client.test.ts`, `src/lib/simplefin/claim.test.ts`

**Interfaces:**
- Consumes: `parseAccountsResponse`, `SfAccount`, `SfBridgeError` (Task 3); `splitAccessUrl` (Task 2)
- Produces:
  - `AUTH_SECRET_KEY = 'simplefin.auth'`
  - `fetchAccounts(net: NetworkAPI, baseUrl: string, opts: FetchAccountsOptions): Promise<{ accounts: SfAccount[]; errors: SfBridgeError[] }>` where `FetchAccountsOptions = { startDate?: number; endDate?: number; pending?: boolean; accountIds?: string[]; balancesOnly?: boolean }` (dates are epoch seconds)
  - `claimSetupToken(net: NetworkAPI, setupToken: string): Promise<string>` returning the raw access URL
  - `createMockHost()` from `src/test/mockHost.ts`, returning `{ api, calls }` for use by every later task

- [ ] **Step 1: Write the shared HostAPI mock**

Create `src/test/mockHost.ts`:

```ts
import { vi } from 'vitest';
import type { HostAPI, NetworkRequest, NetworkResponse } from '@wealthfolio/addon-sdk';

export interface MockHost {
  api: HostAPI;
  /** In-memory stand-ins for the host-side stores, assertable in tests. */
  storage: Map<string, string>;
  secrets: Map<string, string>;
  /** Queue a response for the next network.request matching `urlPattern`. */
  respond(urlPattern: RegExp, response: Partial<NetworkResponse>): void;
  requests: NetworkRequest[];
}

export function createMockHost(): MockHost {
  const storage = new Map<string, string>();
  const secrets = new Map<string, string>();
  const requests: NetworkRequest[] = [];
  const routes: Array<{ pattern: RegExp; response: Partial<NetworkResponse> }> = [];

  const api = {
    storage: {
      get: vi.fn(async (k: string) => storage.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => void storage.set(k, v)),
      delete: vi.fn(async (k: string) => void storage.delete(k)),
    },
    secrets: {
      get: vi.fn(async (k: string) => secrets.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => void secrets.set(k, v)),
      delete: vi.fn(async (k: string) => void secrets.delete(k)),
    },
    network: {
      request: vi.fn(async (req: NetworkRequest): Promise<NetworkResponse> => {
        requests.push(req);
        const match = routes.find((r) => r.pattern.test(req.url));
        if (!match) throw new Error(`no mock route for ${req.url}`);
        return { status: 200, headers: {}, body: '', ...match.response };
      }),
    },
    accounts: { getAll: vi.fn(async () => []), create: vi.fn() },
    activities: { checkImport: vi.fn(), import: vi.fn() },
    snapshots: { checkImport: vi.fn(), importSnapshots: vi.fn() },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
  } as unknown as HostAPI;

  return {
    api,
    storage,
    secrets,
    requests,
    respond: (pattern, response) => void routes.push({ pattern, response }),
  };
}
```

- [ ] **Step 2: Write the failing client tests**

Create `src/lib/simplefin/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import { AUTH_SECRET_KEY, fetchAccounts } from './client';

const BASE = 'https://bridge.simplefin.org/simplefin';

describe('fetchAccounts', () => {
  it('sends a brokered basic-auth request referencing the secret by key', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, { body: JSON.stringify({ accounts: [], errors: [] }) });

    await fetchAccounts(host.api.network, BASE, {});

    const [req] = host.requests;
    expect(req.method).toBe('GET');
    expect(req.auth).toEqual({ type: 'basic', secretKey: AUTH_SECRET_KEY });
    // The credential must never appear in the URL — the host injects it.
    expect(req.url).not.toContain('@');
  });

  it('builds the documented query parameters', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, { body: JSON.stringify({ accounts: [], errors: [] }) });

    await fetchAccounts(host.api.network, BASE, {
      startDate: 1754438400,
      endDate: 1754524800,
      pending: true,
      accountIds: ['A-1', 'A-2'],
    });

    const url = new URL(host.requests[0].url);
    expect(url.pathname).toBe('/simplefin/accounts');
    expect(url.searchParams.get('start-date')).toBe('1754438400');
    expect(url.searchParams.get('end-date')).toBe('1754524800');
    expect(url.searchParams.get('pending')).toBe('1');
    expect(url.searchParams.getAll('account')).toEqual(['A-1', 'A-2']);
  });

  it('omits optional parameters that were not supplied', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, { body: JSON.stringify({ accounts: [], errors: [] }) });

    await fetchAccounts(host.api.network, BASE, {});

    const url = new URL(host.requests[0].url);
    expect(url.searchParams.has('start-date')).toBe(false);
    expect(url.searchParams.has('pending')).toBe(false);
  });

  it('returns bridge errors without throwing so other accounts still sync', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [],
        errlist: [{ code: 'AUTH', msg: 'Reauthenticate Test Bank', conn_id: 'C1' }],
      }),
    });

    const result = await fetchAccounts(host.api.network, BASE, {});
    expect(result.errors).toHaveLength(1);
    expect(result.accounts).toEqual([]);
  });

  it('throws on a non-200 status', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, { status: 403, body: 'Forbidden' });

    await expect(fetchAccounts(host.api.network, BASE, {})).rejects.toThrow(/403/);
  });

  it('throws a clear error when the body is not JSON', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, { body: '<html>gateway error</html>' });

    await expect(fetchAccounts(host.api.network, BASE, {})).rejects.toThrow(/JSON/i);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/simplefin/client.test.ts`
Expected: FAIL — cannot resolve `./client`.

- [ ] **Step 4: Implement the client**

Create `src/lib/simplefin/client.ts`:

```ts
import type { NetworkAPI } from '@wealthfolio/addon-sdk';
import { KEY_PREFIX } from '../constants';
import { parseAccountsResponse, type SfAccount, type SfBridgeError } from './parse';

/** Secret key holding base64(user:pass); resolved host-side by the network broker. */
export const AUTH_SECRET_KEY = `${KEY_PREFIX}.auth`;

export interface FetchAccountsOptions {
  /** Epoch seconds. */
  startDate?: number;
  /** Epoch seconds. */
  endDate?: number;
  pending?: boolean;
  accountIds?: string[];
  balancesOnly?: boolean;
}

export async function fetchAccounts(
  net: NetworkAPI,
  baseUrl: string,
  options: FetchAccountsOptions,
): Promise<{ accounts: SfAccount[]; errors: SfBridgeError[] }> {
  const url = new URL(`${baseUrl}/accounts`);

  if (options.startDate !== undefined) {
    url.searchParams.set('start-date', String(options.startDate));
  }
  if (options.endDate !== undefined) {
    url.searchParams.set('end-date', String(options.endDate));
  }
  if (options.pending) {
    url.searchParams.set('pending', '1');
  }
  if (options.balancesOnly) {
    url.searchParams.set('balances-only', '1');
  }
  for (const id of options.accountIds ?? []) {
    url.searchParams.append('account', id);
  }

  const response = await net.request({
    url: url.toString(),
    method: 'GET',
    auth: { type: 'basic', secretKey: AUTH_SECRET_KEY },
  });

  if (response.status !== 200) {
    throw new Error(`SimpleFIN Bridge returned HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    // Bridges behind a proxy return HTML on outage; surface that plainly
    // rather than letting a SyntaxError bubble up unattributed.
    throw new Error('SimpleFIN Bridge returned a body that is not valid JSON');
  }

  // Bridge errors are returned, not thrown: a failing institution must not
  // prevent the healthy accounts in the same response from syncing.
  return parseAccountsResponse(payload);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/simplefin/client.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Write the failing claim tests**

Create `src/lib/simplefin/claim.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import { claimSetupToken } from './claim';

const CLAIM_URL = 'https://bridge.simplefin.org/simplefin/claim/DEMO';
const ACCESS_URL = 'https://alice:s3cret@bridge.simplefin.org/simplefin';

describe('claimSetupToken', () => {
  it('base64-decodes the token and POSTs to the claim URL', async () => {
    const host = createMockHost();
    host.respond(/\/claim\//, { body: ACCESS_URL });

    const result = await claimSetupToken(host.api.network, btoa(CLAIM_URL));

    expect(host.requests[0].url).toBe(CLAIM_URL);
    expect(host.requests[0].method).toBe('POST');
    expect(result).toBe(ACCESS_URL);
  });

  it('tolerates surrounding whitespace in the pasted token', async () => {
    const host = createMockHost();
    host.respond(/\/claim\//, { body: `  ${ACCESS_URL}\n` });

    const result = await claimSetupToken(host.api.network, `\n ${btoa(CLAIM_URL)} \n`);
    expect(result).toBe(ACCESS_URL);
  });

  it('rejects a token that is not valid base64', async () => {
    const host = createMockHost();
    await expect(claimSetupToken(host.api.network, '!!!not base64!!!')).rejects.toThrow(
      /setup token/i,
    );
  });

  it('reports that a token is single-use when the claim is refused', async () => {
    const host = createMockHost();
    host.respond(/\/claim\//, { status: 403, body: 'Forbidden' });

    await expect(claimSetupToken(host.api.network, btoa(CLAIM_URL))).rejects.toThrow(
      /already been used|HTTP 403/i,
    );
  });
});
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/simplefin/claim.test.ts`
Expected: FAIL — cannot resolve `./claim`.

- [ ] **Step 8: Implement the claim exchange**

Create `src/lib/simplefin/claim.ts`:

```ts
import type { NetworkAPI } from '@wealthfolio/addon-sdk';

/**
 * Exchange a one-time SimpleFIN setup token for a permanent access URL.
 *
 * The setup token is base64 of the claim URL. It is single-use: if this fails
 * after the Bridge has consumed it, the user must generate a fresh token.
 */
export async function claimSetupToken(net: NetworkAPI, setupToken: string): Promise<string> {
  let claimUrl: string;
  try {
    claimUrl = atob(setupToken.trim());
  } catch {
    throw new Error('That does not look like a SimpleFIN setup token (not valid base64)');
  }

  if (!claimUrl.startsWith('https://')) {
    throw new Error('That does not look like a SimpleFIN setup token (no https claim URL)');
  }

  const response = await net.request({ url: claimUrl, method: 'POST', body: '' });

  if (response.status === 403) {
    throw new Error(
      'The Bridge refused this setup token (HTTP 403). Setup tokens are single-use — ' +
        'generate a fresh one in the SimpleFIN Bridge dashboard.',
    );
  }
  if (response.status !== 200) {
    throw new Error(`Claiming the setup token failed: HTTP ${response.status}`);
  }

  return response.body.trim();
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/simplefin/claim.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 10: Add the claim host to the manifest allowlist check**

The claim URL host must already be covered by `network.allowedHosts`. Verify the two declared hosts (`bridge.simplefin.org`, `beta-bridge.simplefin.org`) cover it; if a claim later fails with a broker rejection, that is a manifest allowlist problem, not a code problem — note this in `README.md` under Troubleshooting.

- [ ] **Step 11: Commit**

```bash
git add src/lib/simplefin/client.ts src/lib/simplefin/claim.ts src/test/mockHost.ts \
        src/lib/simplefin/client.test.ts src/lib/simplefin/claim.test.ts
git commit -m "feat: add brokered SimpleFIN client and setup-token claim"
```

---

### Task 5: Storage layer — keys, config, watermark, history

**Files:**
- Create: `src/lib/storage/keys.ts`, `src/lib/storage/config.ts`, `src/lib/storage/watermark.ts`, `src/lib/storage/history.ts`
- Test: `src/lib/storage/keys.test.ts`, `src/lib/storage/config.test.ts`, `src/lib/storage/watermark.test.ts`, `src/lib/storage/history.test.ts`

**Interfaces:**
- Consumes: `KEY_PREFIX` (Task 1), `createMockHost` (Task 4)
- Produces:
  - `storageKey(...parts: string[]): string` — joins with `.`, validates charset and ≤128 length
  - `AccountMapping = { sfAccountId: string; wfAccountId: string; mode: 'CASH' | 'HOLDINGS'; sfAccountName: string; orgName: string }`
  - `readConfig(api)/writeConfig(api, config)` where `SyncConfig = { baseUrl: string | null; mappings: AccountMapping[] }`
  - `readWatermark(api, sfAccountId)/writeWatermark(api, sfAccountId, wm)` where `Watermark = { lastPosted: number; recentIds: string[] }`
  - `RECENT_ID_WINDOW = 500`
  - `shouldPush(wm, txn): boolean`
  - `advanceWatermark(wm, pushedTxns): Watermark`
  - `appendRun(api, run)/readHistory(api)` with `HISTORY_LIMIT = 20`

- [ ] **Step 1: Write the failing watermark tests**

This is the core of the idempotency decision, so it gets the most explicit coverage. Create `src/lib/storage/watermark.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { advanceWatermark, emptyWatermark, RECENT_ID_WINDOW, shouldPush } from './watermark';

const txn = (id: string, posted: number) => ({ id, posted });

describe('shouldPush', () => {
  it('pushes everything when there is no watermark yet', () => {
    expect(shouldPush(emptyWatermark(), txn('T1', 1000))).toBe(true);
  });

  it('skips a transaction already in the recent-id window', () => {
    const wm = { lastPosted: 2000, recentIds: ['T1'] };
    expect(shouldPush(wm, txn('T1', 1500))).toBe(false);
  });

  it('pushes a late-posting transaction dated before the watermark if unseen', () => {
    // The whole reason the recent-id window exists: a transaction can appear
    // in a later fetch with a posted date earlier than the watermark.
    const wm = { lastPosted: 2000, recentIds: ['T1'] };
    expect(shouldPush(wm, txn('T-LATE', 1500))).toBe(true);
  });

  it('pushes a transaction newer than the watermark', () => {
    const wm = { lastPosted: 2000, recentIds: ['T1'] };
    expect(shouldPush(wm, txn('T2', 2500))).toBe(true);
  });
});

describe('advanceWatermark', () => {
  it('moves lastPosted to the newest pushed transaction', () => {
    const wm = advanceWatermark(emptyWatermark(), [txn('T1', 1000), txn('T2', 3000)]);
    expect(wm.lastPosted).toBe(3000);
  });

  it('never moves lastPosted backwards', () => {
    const wm = advanceWatermark({ lastPosted: 5000, recentIds: [] }, [txn('T1', 1000)]);
    expect(wm.lastPosted).toBe(5000);
  });

  it('records pushed ids in the recent window', () => {
    const wm = advanceWatermark(emptyWatermark(), [txn('T1', 1000)]);
    expect(wm.recentIds).toContain('T1');
  });

  it('bounds the recent window, evicting oldest ids first', () => {
    const many = Array.from({ length: RECENT_ID_WINDOW + 50 }, (_, i) => txn(`T${i}`, 1000 + i));
    const wm = advanceWatermark(emptyWatermark(), many);
    expect(wm.recentIds).toHaveLength(RECENT_ID_WINDOW);
    // Newest retained, oldest evicted — the window must trail the newest data.
    expect(wm.recentIds).toContain(`T${RECENT_ID_WINDOW + 49}`);
    expect(wm.recentIds).not.toContain('T0');
  });

  it('is a no-op when nothing was pushed', () => {
    const before = { lastPosted: 2000, recentIds: ['T1'] };
    expect(advanceWatermark(before, [])).toEqual(before);
  });

  it('does not duplicate an id already in the window', () => {
    const wm = advanceWatermark({ lastPosted: 1000, recentIds: ['T1'] }, [txn('T1', 1000)]);
    expect(wm.recentIds.filter((id) => id === 'T1')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/storage/watermark.test.ts`
Expected: FAIL — cannot resolve `./watermark`.

- [ ] **Step 3: Implement the watermark**

Create `src/lib/storage/watermark.ts`:

```ts
import type { HostAPI } from '@wealthfolio/addon-sdk';
import { storageKey } from './keys';

/**
 * `ActivityImport` cannot carry `sourceSystem`/`sourceRecordId`, so Wealthfolio
 * cannot dedupe our pushes for us. The addon owns idempotency instead:
 *
 *  - `lastPosted` — newest posted date we have successfully pushed, so the next
 *    fetch only asks for transactions from there on.
 *  - `recentIds` — a bounded trailing set of SimpleFIN transaction ids we have
 *    already pushed, so a transaction that posts late (dated before the
 *    watermark but appearing in a later fetch) is recognised rather than
 *    re-sent.
 *
 * Bounded by construction: the host caps storage values at ~250 KB, which a
 * full ledger of every synced id would eventually exceed.
 */
export interface Watermark {
  /** Epoch seconds. 0 means "never synced". */
  lastPosted: number;
  recentIds: string[];
}

/**
 * Size of the trailing id window. Chosen to comfortably exceed the number of
 * transactions a single account posts within the re-fetch overlap period while
 * keeping the serialised value far below the host's ~250 KB per-key cap
 * (500 ids x ~40 chars is well under 25 KB).
 */
export const RECENT_ID_WINDOW = 500;

export function emptyWatermark(): Watermark {
  return { lastPosted: 0, recentIds: [] };
}

export interface WatermarkTxn {
  id: string;
  /** Epoch seconds. */
  posted: number;
}

export function shouldPush(wm: Watermark, txn: WatermarkTxn): boolean {
  return !wm.recentIds.includes(txn.id);
}

export function advanceWatermark(wm: Watermark, pushed: WatermarkTxn[]): Watermark {
  if (pushed.length === 0) return wm;

  const newest = pushed.reduce((max, t) => (t.posted > max ? t.posted : max), wm.lastPosted);

  // Append newest-last, then keep the tail — the window must trail the newest
  // data, so eviction takes from the front.
  const seen = new Set(wm.recentIds);
  const appended = [...wm.recentIds];
  for (const t of pushed) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      appended.push(t.id);
    }
  }

  return { lastPosted: newest, recentIds: appended.slice(-RECENT_ID_WINDOW) };
}

export async function readWatermark(api: HostAPI, sfAccountId: string): Promise<Watermark> {
  const raw = await api.storage.get(storageKey('wm', sfAccountId));
  if (!raw) return emptyWatermark();
  try {
    return JSON.parse(raw) as Watermark;
  } catch (error) {
    // A corrupt watermark must not wedge the account. Reset to "never synced"
    // and say so — a re-push is idempotent-ish via checkImport's duplicate
    // detection, whereas a hard failure would block the account forever.
    api.logger.error(
      `[simplefin] corrupt watermark for ${sfAccountId}, resetting: ${String(error)}`,
    );
    return emptyWatermark();
  }
}

export async function writeWatermark(
  api: HostAPI,
  sfAccountId: string,
  wm: Watermark,
): Promise<void> {
  await api.storage.set(storageKey('wm', sfAccountId), JSON.stringify(wm));
}

export async function resetWatermark(api: HostAPI, sfAccountId: string): Promise<void> {
  await api.storage.delete(storageKey('wm', sfAccountId));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/storage/watermark.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Write the failing keys tests**

Create `src/lib/storage/keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { storageKey } from './keys';

describe('storageKey', () => {
  it('namespaces parts under the addon prefix', () => {
    expect(storageKey('wm', 'ACT-1')).toBe('simplefin.wm.ACT-1');
  });

  it('replaces characters outside the host-allowed charset', () => {
    // Host allows [A-Za-z0-9_.:-] only.
    expect(storageKey('wm', 'ACT/1 2')).toBe('simplefin.wm.ACT_1_2');
  });

  it('rejects a key that exceeds the host limit of 128 characters', () => {
    expect(() => storageKey('wm', 'x'.repeat(200))).toThrow(/128/);
  });
});
```

- [ ] **Step 6: Implement keys**

Create `src/lib/storage/keys.ts`:

```ts
import { KEY_PREFIX } from '../constants';

/** The host restricts storage keys to this charset and 128 characters. */
const ALLOWED = /[^A-Za-z0-9_.:-]/g;
const MAX_KEY_LENGTH = 128;

export function storageKey(...parts: string[]): string {
  const key = [KEY_PREFIX, ...parts].join('.').replace(ALLOWED, '_');

  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(
      `storage key "${key.slice(0, 32)}..." is ${key.length} chars; the host limit is ${MAX_KEY_LENGTH}`,
    );
  }

  return key;
}
```

- [ ] **Step 7: Run keys tests**

Run: `pnpm vitest run src/lib/storage/keys.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 8: Write the failing config tests**

Create `src/lib/storage/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import { readConfig, writeConfig } from './config';

describe('config', () => {
  it('returns an empty config when nothing is stored', async () => {
    const host = createMockHost();
    expect(await readConfig(host.api)).toEqual({ baseUrl: null, mappings: [] });
  });

  it('round-trips a config', async () => {
    const host = createMockHost();
    const config = {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [
        {
          sfAccountId: 'ACT-1',
          wfAccountId: 'WF-1',
          mode: 'CASH' as const,
          sfAccountName: 'Checking',
          orgName: 'Test Bank',
        },
      ],
    };
    await writeConfig(host.api, config);
    expect(await readConfig(host.api)).toEqual(config);
  });

  it('never stores credentials in the base URL', async () => {
    const host = createMockHost();
    await writeConfig(host.api, {
      baseUrl: 'https://bridge.simplefin.org/simplefin',
      mappings: [],
    });
    const stored = [...host.storage.values()].join('');
    expect(stored).not.toContain('@');
  });

  it('recovers from a corrupt config rather than throwing', async () => {
    const host = createMockHost();
    await host.api.storage.set('simplefin.config', '{not json');
    expect(await readConfig(host.api)).toEqual({ baseUrl: null, mappings: [] });
    expect(host.api.logger.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 9: Implement config**

Create `src/lib/storage/config.ts`:

```ts
import type { HostAPI } from '@wealthfolio/addon-sdk';
import { storageKey } from './keys';

/** How a mapped SimpleFIN account is pushed into Wealthfolio. */
export type SyncMode = 'CASH' | 'HOLDINGS';

export interface AccountMapping {
  sfAccountId: string;
  wfAccountId: string;
  mode: SyncMode;
  /** Cached for display when the Bridge is unreachable. */
  sfAccountName: string;
  orgName: string;
}

export interface SyncConfig {
  /** Credential-free SimpleFIN base URL. Credentials live in `secrets`. */
  baseUrl: string | null;
  mappings: AccountMapping[];
}

const CONFIG_KEY = storageKey('config');

export function emptyConfig(): SyncConfig {
  return { baseUrl: null, mappings: [] };
}

export async function readConfig(api: HostAPI): Promise<SyncConfig> {
  const raw = await api.storage.get(CONFIG_KEY);
  if (!raw) return emptyConfig();

  try {
    return JSON.parse(raw) as SyncConfig;
  } catch (error) {
    // Returning empty sends the user back to setup, which is recoverable;
    // throwing here would leave the addon permanently unopenable.
    api.logger.error(`[simplefin] corrupt config, falling back to empty: ${String(error)}`);
    return emptyConfig();
  }
}

export async function writeConfig(api: HostAPI, config: SyncConfig): Promise<void> {
  await api.storage.set(CONFIG_KEY, JSON.stringify(config));
}
```

- [ ] **Step 10: Write and implement history**

Create `src/lib/storage/history.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import { appendRun, HISTORY_LIMIT, readHistory } from './history';

const run = (startedAt: string) => ({
  startedAt,
  finishedAt: startedAt,
  accounts: [],
  bridgeErrors: [],
});

describe('history', () => {
  it('returns an empty list when nothing is stored', async () => {
    const host = createMockHost();
    expect(await readHistory(host.api)).toEqual([]);
  });

  it('stores newest first', async () => {
    const host = createMockHost();
    await appendRun(host.api, run('2026-08-01T00:00:00Z'));
    await appendRun(host.api, run('2026-08-02T00:00:00Z'));
    const history = await readHistory(host.api);
    expect(history[0].startedAt).toBe('2026-08-02T00:00:00Z');
  });

  it('bounds the history so the value stays under the host size cap', async () => {
    const host = createMockHost();
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
      await appendRun(host.api, run(`2026-08-01T00:00:${String(i).padStart(2, '0')}Z`));
    }
    expect(await readHistory(host.api)).toHaveLength(HISTORY_LIMIT);
  });
});
```

Create `src/lib/storage/history.ts`:

```ts
import type { HostAPI } from '@wealthfolio/addon-sdk';
import type { SfBridgeError } from '../simplefin/parse';
import { storageKey } from './keys';

export interface AccountRunResult {
  sfAccountId: string;
  sfAccountName: string;
  orgName: string;
  wfAccountId: string;
  mode: 'CASH' | 'HOLDINGS';
  /** null when the account failed before anything was counted. */
  imported: number | null;
  skipped: number | null;
  duplicates: number | null;
  /** Populated only when this account failed; other accounts are unaffected. */
  error: string | null;
  /** Set when SimpleFIN and Wealthfolio balances disagree after the run. */
  balanceMismatch: { simplefin: string; wealthfolio: string } | null;
}

export interface SyncRun {
  startedAt: string;
  finishedAt: string;
  accounts: AccountRunResult[];
  bridgeErrors: SfBridgeError[];
}

/**
 * Runs retained. The whole history is one storage value, and the host caps
 * values at ~250 KB; 20 runs across a realistic account count stays far below
 * that while covering enough history to spot a recurring failure.
 */
export const HISTORY_LIMIT = 20;

const HISTORY_KEY = storageKey('history');

export async function readHistory(api: HostAPI): Promise<SyncRun[]> {
  const raw = await api.storage.get(HISTORY_KEY);
  if (!raw) return [];

  try {
    return JSON.parse(raw) as SyncRun[];
  } catch (error) {
    api.logger.error(`[simplefin] corrupt history, starting fresh: ${String(error)}`);
    return [];
  }
}

export async function appendRun(api: HostAPI, run: SyncRun): Promise<void> {
  const history = await readHistory(api);
  const next = [run, ...history].slice(0, HISTORY_LIMIT);
  await api.storage.set(HISTORY_KEY, JSON.stringify(next));
}
```

- [ ] **Step 11: Run the whole storage suite**

Run: `pnpm vitest run src/lib/storage`
Expected: PASS, all tests across the four files.

- [ ] **Step 12: Commit**

```bash
git add src/lib/storage src/lib/constants.ts
git commit -m "feat: add storage layer with bounded watermark, config and history"
```

---

### Task 6: Cash transaction sync

**Files:**
- Create: `src/lib/sync/activities.ts`
- Test: `src/lib/sync/activities.test.ts`

**Interfaces:**
- Consumes: `SfAccount`, `SfTransaction` (Task 3); `Watermark`, `shouldPush`, `advanceWatermark` (Task 5); `AccountMapping` (Task 5)
- Produces:
  - `toActivityImport(txn: SfTransaction, mapping: AccountMapping, currency: string): ActivityImport`
  - `syncCashAccount(api, mapping, sfAccount, wm): Promise<{ result: Pick<AccountRunResult,'imported'|'skipped'|'duplicates'>; watermark: Watermark }>`

SimpleFIN amounts are signed: negative is money out. Wealthfolio's cash activity types are `DEPOSIT` (in) and `WITHDRAWAL` (out), with a positive magnitude in `amount`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/sync/activities.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import type { AccountMapping } from '../storage/config';
import { emptyWatermark } from '../storage/watermark';
import { syncCashAccount, toActivityImport } from './activities';

const mapping: AccountMapping = {
  sfAccountId: 'ACT-1',
  wfAccountId: 'WF-1',
  mode: 'CASH',
  sfAccountName: 'Checking',
  orgName: 'Test Bank',
};

const txn = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'TXN-1',
  posted: 1754438400,
  amount: '-42.10',
  description: 'COFFEE',
  payee: 'Blue Bottle',
  memo: null,
  pending: false,
  ...over,
});

describe('toActivityImport', () => {
  it('maps a negative amount to a WITHDRAWAL with positive magnitude', () => {
    const activity = toActivityImport(txn() as never, mapping, 'USD');
    expect(activity.activityType).toBe('WITHDRAWAL');
    expect(activity.amount).toBe('42.10');
    expect(activity.accountId).toBe('WF-1');
    expect(activity.currency).toBe('USD');
  });

  it('maps a positive amount to a DEPOSIT', () => {
    const activity = toActivityImport(txn({ amount: '2000.00' }) as never, mapping, 'USD');
    expect(activity.activityType).toBe('DEPOSIT');
    expect(activity.amount).toBe('2000.00');
  });

  it('keeps the amount as a string to avoid float rounding', () => {
    const activity = toActivityImport(txn({ amount: '-0.1' }) as never, mapping, 'USD');
    expect(typeof activity.amount).toBe('string');
    expect(activity.amount).toBe('0.1');
  });

  it('prefers payee over description for the comment, falling back to description', () => {
    expect(toActivityImport(txn() as never, mapping, 'USD').comment).toBe('Blue Bottle');
    expect(
      toActivityImport(txn({ payee: null }) as never, mapping, 'USD').comment,
    ).toBe('COFFEE');
  });

  it('converts the epoch posted date to an ISO date', () => {
    const activity = toActivityImport(txn() as never, mapping, 'USD');
    expect(activity.date).toBe('2026-08-06');
  });
});

describe('syncCashAccount', () => {
  const account = (transactions: unknown[]) => ({
    id: 'ACT-1',
    name: 'Checking',
    currency: 'USD',
    balance: '100.00',
    balanceDate: 1754524800,
    orgName: 'Test Bank',
    transactions,
    holdings: [],
  });

  it('skips pending transactions', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a) => a);
    host.api.activities.import = vi.fn(async () => ({
      activities: [],
      importRunId: 'R1',
      summary: { total: 0, imported: 0, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));

    await syncCashAccount(
      host.api,
      mapping,
      account([txn({ pending: true })]) as never,
      emptyWatermark(),
    );

    expect(host.api.activities.import).not.toHaveBeenCalled();
  });

  it('skips transactions already in the recent-id window', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a) => a);

    await syncCashAccount(host.api, mapping, account([txn()]) as never, {
      lastPosted: 1754438400,
      recentIds: ['TXN-1'],
    });

    expect(host.api.activities.import).not.toHaveBeenCalled();
  });

  it('validates via checkImport before importing', async () => {
    const host = createMockHost();
    const order: string[] = [];
    host.api.activities.checkImport = vi.fn(async (a) => {
      order.push('check');
      return a;
    });
    host.api.activities.import = vi.fn(async () => {
      order.push('import');
      return {
        activities: [],
        importRunId: 'R1',
        summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
      };
    });

    await syncCashAccount(host.api, mapping, account([txn()]) as never, emptyWatermark());
    expect(order).toEqual(['check', 'import']);
  });

  it('does not import rows the host flagged as duplicates', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a) =>
      a.map((row) => ({ ...row, duplicateOfId: 'EXISTING', isValid: true })),
    );
    host.api.activities.import = vi.fn();

    const { result } = await syncCashAccount(
      host.api,
      mapping,
      account([txn()]) as never,
      emptyWatermark(),
    );

    expect(host.api.activities.import).not.toHaveBeenCalled();
    expect(result.duplicates).toBe(1);
  });

  it('does not import rows checkImport marked invalid', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a) =>
      a.map((row) => ({ ...row, isValid: false, errors: { amount: ['bad'] } })),
    );
    host.api.activities.import = vi.fn();

    const { result } = await syncCashAccount(
      host.api,
      mapping,
      account([txn()]) as never,
      emptyWatermark(),
    );

    expect(host.api.activities.import).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('advances the watermark only over transactions actually imported', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a) => a);
    host.api.activities.import = vi.fn(async () => ({
      activities: [],
      importRunId: 'R1',
      summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));

    const { watermark } = await syncCashAccount(
      host.api,
      mapping,
      account([txn()]) as never,
      emptyWatermark(),
    );

    expect(watermark.lastPosted).toBe(1754438400);
    expect(watermark.recentIds).toContain('TXN-1');
  });

  it('leaves the watermark untouched when the import throws', async () => {
    const host = createMockHost();
    host.api.activities.checkImport = vi.fn(async (a) => a);
    host.api.activities.import = vi.fn(async () => {
      throw new Error('host exploded');
    });

    const before = emptyWatermark();
    await expect(
      syncCashAccount(host.api, mapping, account([txn()]) as never, before),
    ).rejects.toThrow(/host exploded/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/sync/activities.test.ts`
Expected: FAIL — cannot resolve `./activities`.

- [ ] **Step 3: Implement**

Create `src/lib/sync/activities.ts`:

```ts
import type { ActivityImport, HostAPI } from '@wealthfolio/addon-sdk';
import type { SfAccount, SfTransaction } from '../simplefin/parse';
import type { AccountMapping } from '../storage/config';
import { advanceWatermark, shouldPush, type Watermark } from '../storage/watermark';

/** Epoch seconds -> YYYY-MM-DD in UTC, the form Wealthfolio's importer expects. */
function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
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
): ActivityImport {
  const isOutflow = txn.amount.trim().startsWith('-');
  const magnitude = txn.amount.trim().replace(/^-/, '');

  return {
    accountId: mapping.wfAccountId,
    activityType: (isOutflow ? 'WITHDRAWAL' : 'DEPOSIT') as ActivityImport['activityType'],
    date: isoDate(txn.posted),
    amount: magnitude,
    currency,
    comment: txn.payee || txn.description,
    isValid: true,
    isDraft: false,
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
): Promise<{ result: CashSyncCounts; watermark: Watermark }> {
  // Pending transactions are excluded from v1: their id and amount can both
  // change once posted, which would push a row we could never reconcile.
  const candidates = sfAccount.transactions.filter(
    (t) => !t.pending && shouldPush(watermark, t),
  );

  if (candidates.length === 0) {
    return { result: { imported: 0, skipped: 0, duplicates: 0 }, watermark };
  }

  const rows = candidates.map((t) => toActivityImport(t, mapping, sfAccount.currency));
  const checked = await api.activities.checkImport(rows);

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
    // Duplicates were genuinely already present, so the watermark may still
    // advance over them — otherwise every run re-checks the same rows forever.
    const advanced = advanceWatermark(
      watermark,
      candidates.filter((_, i) => checked[i].duplicateOfId),
    );
    return { result: { imported: 0, skipped, duplicates }, watermark: advanced };
  }

  const outcome = await api.activities.import(importable);

  return {
    result: { imported: outcome.summary.imported, skipped, duplicates },
    // Only advance over what was actually accepted — if the import throws, this
    // line is never reached and the watermark stays put, so the next run retries.
    watermark: advanceWatermark(watermark, importableTxns),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/sync/activities.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Verify the transform against real output (project rule 1)**

Before committing, run the transform over a real Bridge payload and read the result. Use the SimpleFIN demo access URL (`https://demo:demo@beta-bridge.simplefin.org/simplefin`) via a throwaway node script, print three mapped `ActivityImport` rows, and confirm by eye: sign direction is right, dates are the posted dates, amounts have no float artefacts. Passing tests are not sufficient here — this is a data transformation.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sync/activities.ts src/lib/sync/activities.test.ts
git commit -m "feat: sync SimpleFIN cash transactions with watermark-based idempotency"
```

---

### Task 7: Holdings snapshot sync

**Files:**
- Create: `src/lib/sync/snapshots.ts`
- Test: `src/lib/sync/snapshots.test.ts`

**Interfaces:**
- Consumes: `SfAccount`, `SfHolding` (Task 3); `AccountMapping` (Task 5)
- Produces: `syncHoldingsAccount(api, mapping, sfAccount): Promise<{ imported: number; skipped: number }>`

Holdings need no watermark: `snapshots.checkImport()` returns `existingDates`, giving host-side idempotency for free. A snapshot for a date already present is skipped.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/sync/snapshots.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import type { AccountMapping } from '../storage/config';
import { syncHoldingsAccount, toSnapshotInput } from './snapshots';

const mapping: AccountMapping = {
  sfAccountId: 'ACT-2',
  wfAccountId: 'WF-2',
  mode: 'HOLDINGS',
  sfAccountName: 'Brokerage',
  orgName: 'Test Broker',
};

const account = (holdings: unknown[], balance = '500.00') => ({
  id: 'ACT-2',
  name: 'Brokerage',
  currency: 'USD',
  balance,
  balanceDate: 1754524800,
  orgName: 'Test Broker',
  transactions: [],
  holdings,
});

const holding = (over = {}) => ({
  symbol: 'AAPL',
  shares: '10',
  currency: 'USD',
  costBasis: '1500.00',
  purchasePrice: '150.00',
  marketValue: '2000.00',
  ...over,
});

describe('toSnapshotInput', () => {
  it('maps holdings to positions dated by the balance date', () => {
    const snapshot = toSnapshotInput(account([holding()]) as never);
    expect(snapshot.date).toBe('2026-08-07');
    expect(snapshot.positions).toEqual([
      { symbol: 'AAPL', quantity: '10', avgCost: '150.00', currency: 'USD' },
    ]);
  });

  it('carries the account cash balance', () => {
    const snapshot = toSnapshotInput(account([holding()]) as never);
    expect(snapshot.cashBalances).toEqual({ USD: '500.00' });
  });

  it('drops holdings with no symbol, which cannot be resolved to an asset', () => {
    const snapshot = toSnapshotInput(account([holding({ symbol: '' })]) as never);
    expect(snapshot.positions).toEqual([]);
  });

  it('drops holdings with no share count', () => {
    const snapshot = toSnapshotInput(account([holding({ shares: null })]) as never);
    expect(snapshot.positions).toEqual([]);
  });
});

describe('syncHoldingsAccount', () => {
  it('skips a snapshot whose date already exists', async () => {
    const host = createMockHost();
    host.api.snapshots.checkImport = vi.fn(async () => ({
      existingDates: ['2026-08-07'],
      symbols: [],
      validationErrors: [],
    }));
    host.api.snapshots.importSnapshots = vi.fn();

    const result = await syncHoldingsAccount(host.api, mapping, account([holding()]) as never);

    expect(host.api.snapshots.importSnapshots).not.toHaveBeenCalled();
    expect(result).toEqual({ imported: 0, skipped: 1 });
  });

  it('imports a snapshot for a new date', async () => {
    const host = createMockHost();
    host.api.snapshots.checkImport = vi.fn(async () => ({
      existingDates: [],
      symbols: [],
      validationErrors: [],
    }));
    host.api.snapshots.importSnapshots = vi.fn(async () => ({
      snapshotsImported: 1,
      snapshotsFailed: 0,
      errors: [],
    }));

    const result = await syncHoldingsAccount(host.api, mapping, account([holding()]) as never);

    expect(host.api.snapshots.importSnapshots).toHaveBeenCalledWith('WF-2', expect.any(Array));
    expect(result).toEqual({ imported: 1, skipped: 0 });
  });

  it('throws when checkImport reports validation errors', async () => {
    const host = createMockHost();
    host.api.snapshots.checkImport = vi.fn(async () => ({
      existingDates: [],
      symbols: [],
      validationErrors: ['unknown symbol ZZZZ'],
    }));

    await expect(
      syncHoldingsAccount(host.api, mapping, account([holding()]) as never),
    ).rejects.toThrow(/unknown symbol ZZZZ/);
  });

  it('does nothing for an account with no holdings', async () => {
    const host = createMockHost();
    host.api.snapshots.checkImport = vi.fn();

    const result = await syncHoldingsAccount(host.api, mapping, account([]) as never);

    expect(host.api.snapshots.checkImport).not.toHaveBeenCalled();
    expect(result).toEqual({ imported: 0, skipped: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/sync/snapshots.test.ts`
Expected: FAIL — cannot resolve `./snapshots`.

- [ ] **Step 3: Implement**

Create `src/lib/sync/snapshots.ts`:

```ts
import type { HostAPI, SnapshotInput } from '@wealthfolio/addon-sdk';
import type { SfAccount } from '../simplefin/parse';
import type { AccountMapping } from '../storage/config';

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/sync/snapshots.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/snapshots.ts src/lib/sync/snapshots.test.ts
git commit -m "feat: sync SimpleFIN holdings as Wealthfolio snapshots"
```

---

### Task 8: Sync orchestration with per-account isolation

**Files:**
- Create: `src/lib/sync/run.ts`, `src/lib/sync/balance.ts`
- Test: `src/lib/sync/run.test.ts`, `src/lib/sync/balance.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–7
- Produces: `runSync(api, config): Promise<SyncRun>` — never throws for a per-account failure; records it and continues.

- [ ] **Step 1: Write the failing balance tests**

Create `src/lib/sync/balance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { compareBalances } from './balance';

describe('compareBalances', () => {
  it('reports no mismatch for equal balances', () => {
    expect(compareBalances('100.00', '100.00')).toBeNull();
  });

  it('treats differing decimal representations of the same value as equal', () => {
    expect(compareBalances('100.0', '100.00')).toBeNull();
    expect(compareBalances('-0.00', '0.00')).toBeNull();
  });

  it('reports a mismatch with both figures', () => {
    expect(compareBalances('100.00', '90.00')).toEqual({
      simplefin: '100.00',
      wealthfolio: '90.00',
    });
  });

  it('returns null when the Wealthfolio balance is unavailable', () => {
    // Rule: if a value cannot be computed, return null rather than a magic number.
    expect(compareBalances('100.00', null)).toBeNull();
  });
});
```

- [ ] **Step 2: Implement balance comparison**

Create `src/lib/sync/balance.ts`:

```ts
/**
 * Compare two decimal strings without going through float. Balances are
 * compared by normalised value, so "100.0" and "100.00" agree.
 */
function normalise(value: string): string {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const [whole, fraction = ''] = trimmed.replace(/^[-+]/, '').split('.');
  const cleanWhole = whole.replace(/^0+(?=\d)/, '');
  const cleanFraction = fraction.replace(/0+$/, '');
  const magnitude = cleanFraction ? `${cleanWhole}.${cleanFraction}` : cleanWhole;

  // -0 and 0 are the same balance.
  if (/^0(\.0*)?$/.test(magnitude)) return '0';
  return negative ? `-${magnitude}` : magnitude;
}

export interface BalanceMismatch {
  simplefin: string;
  wealthfolio: string;
}

export function compareBalances(
  simplefin: string,
  wealthfolio: string | null,
): BalanceMismatch | null {
  // No Wealthfolio figure means the check could not be computed — report
  // nothing rather than inventing a comparison.
  if (wealthfolio === null) return null;

  return normalise(simplefin) === normalise(wealthfolio)
    ? null
    : { simplefin, wealthfolio };
}
```

- [ ] **Step 3: Run balance tests**

Run: `pnpm vitest run src/lib/sync/balance.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 4: Write the failing orchestration tests**

Create `src/lib/sync/run.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../../test/mockHost';
import type { SyncConfig } from '../storage/config';
import { runSync } from './run';

const config: SyncConfig = {
  baseUrl: 'https://bridge.simplefin.org/simplefin',
  mappings: [
    { sfAccountId: 'ACT-1', wfAccountId: 'WF-1', mode: 'CASH', sfAccountName: 'Checking', orgName: 'Bank A' },
    { sfAccountId: 'ACT-2', wfAccountId: 'WF-2', mode: 'CASH', sfAccountName: 'Savings', orgName: 'Bank B' },
  ],
};

const bridgePayload = {
  errors: [],
  accounts: [
    {
      org: { name: 'Bank A' }, id: 'ACT-1', name: 'Checking', currency: 'USD',
      balance: '100.00', 'balance-date': 1754524800,
      transactions: [{ id: 'T1', posted: 1754438400, amount: '-10.00', description: 'X' }],
      holdings: [],
    },
    {
      org: { name: 'Bank B' }, id: 'ACT-2', name: 'Savings', currency: 'USD',
      balance: '200.00', 'balance-date': 1754524800,
      transactions: [{ id: 'T2', posted: 1754438400, amount: '-20.00', description: 'Y' }],
      holdings: [],
    },
  ],
};

function okHost() {
  const host = createMockHost();
  host.respond(/\/accounts/, { body: JSON.stringify(bridgePayload) });
  host.api.activities.checkImport = vi.fn(async (a) => a);
  host.api.activities.import = vi.fn(async () => ({
    activities: [], importRunId: 'R',
    summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
  }));
  host.api.accounts.getAll = vi.fn(async () => []);
  return host;
}

describe('runSync', () => {
  it('syncs every mapped account', async () => {
    const run = await runSync(okHost().api, config);
    expect(run.accounts).toHaveLength(2);
    expect(run.accounts.every((a) => a.error === null)).toBe(true);
  });

  it('isolates a per-account failure so the others still sync', async () => {
    const host = okHost();
    host.api.activities.import = vi.fn(async (rows) => {
      if (rows[0].accountId === 'WF-1') throw new Error('WF-1 exploded');
      return {
        activities: [], importRunId: 'R',
        summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
      };
    });

    const run = await runSync(host.api, config);

    const first = run.accounts.find((a) => a.wfAccountId === 'WF-1');
    const second = run.accounts.find((a) => a.wfAccountId === 'WF-2');
    expect(first?.error).toMatch(/exploded/);
    expect(second?.error).toBeNull();
    expect(second?.imported).toBe(1);
  });

  it('records bridge errors without aborting the run', async () => {
    const host = createMockHost();
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        ...bridgePayload,
        errlist: [{ code: 'AUTH', msg: 'Reauthenticate Bank A', conn_id: 'C1' }],
      }),
    });
    host.api.activities.checkImport = vi.fn(async (a) => a);
    host.api.activities.import = vi.fn(async () => ({
      activities: [], importRunId: 'R',
      summary: { total: 1, imported: 1, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
    }));
    host.api.accounts.getAll = vi.fn(async () => []);

    const run = await runSync(host.api, config);
    expect(run.bridgeErrors).toHaveLength(1);
    expect(run.accounts).toHaveLength(2);
  });

  it('records an account mapped to an id the Bridge did not return', async () => {
    const host = okHost();
    const run = await runSync(host.api, {
      ...config,
      mappings: [
        ...config.mappings,
        { sfAccountId: 'GONE', wfAccountId: 'WF-3', mode: 'CASH', sfAccountName: 'Old', orgName: 'Bank C' },
      ],
    });
    const missing = run.accounts.find((a) => a.wfAccountId === 'WF-3');
    expect(missing?.error).toMatch(/not returned by the Bridge/i);
  });

  it('persists the run to history', async () => {
    const host = okHost();
    await runSync(host.api, config);
    expect(host.storage.has('simplefin.history')).toBe(true);
  });

  it('throws when there is no configured base URL', async () => {
    const host = okHost();
    await expect(runSync(host.api, { ...config, baseUrl: null })).rejects.toThrow(/not connected/i);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/sync/run.test.ts`
Expected: FAIL — cannot resolve `./run`.

- [ ] **Step 6: Implement orchestration**

Create `src/lib/sync/run.ts`:

```ts
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
    const { result, watermark: next } = await syncCashAccount(
      api,
      mapping,
      sfAccount,
      watermark,
    );
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
      const balance = (account as unknown as { balance?: string }).balance;
      if (balance !== undefined) wfBalances.set(account.id, String(balance));
    }
  } catch (error) {
    api.logger.error(
      `[simplefin] could not read Wealthfolio balances for the mismatch check: ${String(error)}`,
    );
  }

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
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/sync`
Expected: PASS, all sync tests.

- [ ] **Step 8: Commit**

```bash
git add src/lib/sync/run.ts src/lib/sync/balance.ts src/lib/sync/run.test.ts src/lib/sync/balance.test.ts
git commit -m "feat: orchestrate sync with per-account failure isolation"
```

---

### Task 9: Setup and account-mapping UI

**Files:**
- Create: `src/pages/SyncPage.tsx`, `src/components/SetupCard.tsx`, `src/components/AccountMapTable.tsx`
- Modify: `src/addon.tsx`
- Test: `src/pages/SyncPage.test.tsx`

**Interfaces:**
- Consumes: `claimSetupToken`, `splitAccessUrl`, `AUTH_SECRET_KEY`, `fetchAccounts`, `readConfig`, `writeConfig`
- Produces: the route component the host mounts.

- [ ] **Step 1: Write the failing tests**

Create `src/pages/SyncPage.test.tsx` covering exactly these behaviours:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMockHost } from '../test/mockHost';
import { SyncPage } from './SyncPage';

describe('SyncPage', () => {
  it('shows the setup card when no base URL is configured', async () => {
    const host = createMockHost();
    render(<SyncPage api={host.api} />);
    expect(await screen.findByText(/connect to simplefin/i)).toBeInTheDocument();
  });

  it('claims a token and stores credentials in secrets, not storage', async () => {
    const host = createMockHost();
    host.respond(/\/claim\//, { body: 'https://alice:s3cret@bridge.simplefin.org/simplefin' });
    host.respond(/\/accounts/, { body: JSON.stringify({ accounts: [], errors: [] }) });

    render(<SyncPage api={host.api} />);
    await userEvent.type(
      await screen.findByLabelText(/setup token/i),
      btoa('https://bridge.simplefin.org/simplefin/claim/DEMO'),
    );
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));

    await waitFor(() => expect(host.secrets.get('simplefin.auth')).toBe(btoa('alice:s3cret')));
    // The credential must never reach durable storage.
    expect([...host.storage.values()].join('')).not.toContain('s3cret');
  });

  it('surfaces a claim failure to the user instead of failing silently', async () => {
    const host = createMockHost();
    host.respond(/\/claim\//, { status: 403, body: 'Forbidden' });

    render(<SyncPage api={host.api} />);
    await userEvent.type(await screen.findByLabelText(/setup token/i), btoa('https://x/claim/D'));
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));

    expect(await screen.findByText(/single-use/i)).toBeInTheDocument();
  });

  it('lists SimpleFIN accounts alongside Wealthfolio accounts once connected', async () => {
    const host = createMockHost();
    await host.api.storage.set(
      'simplefin.config',
      JSON.stringify({ baseUrl: 'https://bridge.simplefin.org/simplefin', mappings: [] }),
    );
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [{ id: 'ACT-1', name: 'Checking', currency: 'USD', balance: '1.00', 'balance-date': 1, org: { name: 'Bank A' } }],
        errors: [],
      }),
    });
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'WF-1', name: 'My Checking' }] as never);

    render(<SyncPage api={host.api} />);
    expect(await screen.findByText('Checking')).toBeInTheDocument();
    expect(await screen.findByText('Bank A')).toBeInTheDocument();
  });

  it('persists a chosen mapping', async () => {
    const host = createMockHost();
    await host.api.storage.set(
      'simplefin.config',
      JSON.stringify({ baseUrl: 'https://bridge.simplefin.org/simplefin', mappings: [] }),
    );
    host.respond(/\/accounts/, {
      body: JSON.stringify({
        accounts: [{ id: 'ACT-1', name: 'Checking', currency: 'USD', balance: '1.00', 'balance-date': 1, org: { name: 'Bank A' } }],
        errors: [],
      }),
    });
    host.api.accounts.getAll = vi.fn(async () => [{ id: 'WF-1', name: 'My Checking' }] as never);

    render(<SyncPage api={host.api} />);
    await userEvent.selectOptions(await screen.findByLabelText(/map checking/i), 'WF-1');

    await waitFor(() => {
      const config = JSON.parse(host.storage.get('simplefin.config') as string);
      expect(config.mappings).toEqual([
        expect.objectContaining({ sfAccountId: 'ACT-1', wfAccountId: 'WF-1' }),
      ]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/pages/SyncPage.test.tsx`
Expected: FAIL — cannot resolve `./SyncPage`.

- [ ] **Step 3: Implement `SetupCard`**

Create `src/components/SetupCard.tsx`. It renders a labelled textarea ("Setup token") and a "Connect" button. On submit it calls `claimSetupToken`, then `splitAccessUrl`, then `api.secrets.set(AUTH_SECRET_KEY, basicAuthSecret)` and `writeConfig(api, { baseUrl, mappings: [] })`. Errors are caught and rendered in an alert region — never swallowed. Take `api: HostAPI` and `onConnected: () => void` as props.

- [ ] **Step 4: Implement `AccountMapTable`**

Create `src/components/AccountMapTable.tsx`. Props: `sfAccounts: SfAccount[]`, `wfAccounts: Account[]`, `mappings: AccountMapping[]`, `onChange(mappings: AccountMapping[]): void`. One row per SimpleFIN account showing org name, account name, currency and balance, plus a `<select>` labelled `Map {accountName}` listing Wealthfolio accounts, an "unmapped" option, and a mode selector (`CASH`/`HOLDINGS`) defaulting to `HOLDINGS` when the SimpleFIN account reports holdings.

- [ ] **Step 5: Implement `SyncPage`**

Create `src/pages/SyncPage.tsx`. Props: `{ api: HostAPI }`. On mount it reads config; if `baseUrl` is null it renders `SetupCard`, otherwise it fetches SimpleFIN accounts and Wealthfolio accounts in parallel and renders `AccountMapTable`. Mapping changes are written through `writeConfig` immediately.

- [ ] **Step 6: Wire the route in `src/addon.tsx`**

Replace the scaffolded example component with `SyncPage`, keeping the exact `component:` pattern and the captured-context idiom the template established:

```tsx
const AddonRoute = () => (
  <QueryClientProvider client={addonCtx!.api.query.getClient() as QueryClient}>
    <SyncPage api={addonCtx!.api} />
  </QueryClientProvider>
);

const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;
  ctx.router.add({ id: ADDON_ID, path: `/addons/${ADDON_ID}`, component: AddonRoute });
  ctx.onDisable(() => {
    addonCtx = undefined;
  });
};
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run src/pages/SyncPage.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 8: Commit**

```bash
git add src/pages src/components src/addon.tsx
git commit -m "feat: add setup and account-mapping UI"
```

---

### Task 10: Sync trigger, results, errors and history UI

**Files:**
- Create: `src/components/SyncSummary.tsx`, `src/components/BridgeErrorBanner.tsx`, `src/components/HistoryList.tsx`
- Modify: `src/pages/SyncPage.tsx`
- Test: `src/pages/SyncPage.sync.test.tsx`

**Interfaces:**
- Consumes: `runSync`, `readHistory`, `bridgeDashboardUrl`, `SyncRun`, `AccountRunResult`
- Produces: the complete v1 UI.

- [ ] **Step 1: Write the failing tests**

Create `src/pages/SyncPage.sync.test.tsx` covering:

```
- clicking "Sync now" calls runSync and renders per-account imported counts
- a per-account error renders that account as failed while others show success
- a bridge error renders a banner naming the institution with a link to the
  Bridge dashboard host (not the credentialed URL)
- a balance mismatch renders both figures for the affected account
- the sync button is disabled while a run is in flight
- history renders previous runs newest-first after a completed run
```

Each assertion queries by accessible role/text, matching the style of Task 9's tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/pages/SyncPage.sync.test.tsx`
Expected: FAIL — the sync button does not exist yet.

- [ ] **Step 3: Implement `BridgeErrorBanner`**

Props: `errors: SfBridgeError[]`, `dashboardUrl: string`. Renders one alert per error using `msg` (already human-readable and institution-named), each with an "Open SimpleFIN Bridge" link to `dashboardUrl`. Renders nothing when `errors` is empty.

- [ ] **Step 4: Implement `SyncSummary`**

Props: `run: SyncRun`. One row per account.

**Order the columns so reading order matches the arithmetic** (learned rule 5): account, imported, skipped, duplicates, then the resulting total, then the balance reconciliation. Leading with the total forces the reader to work backwards.

Failed accounts render their `error` inline; accounts whose counts are `null` render "—", never `0` (a null count means "not computed", which is not the same as zero).

- [ ] **Step 5: Implement `HistoryList`**

Props: `runs: SyncRun[]`. Renders each run's timestamp, total imported, and a failure count, newest first.

- [ ] **Step 6: Wire into `SyncPage`**

Add a "Sync now" button, disabled while a run is in flight. On completion, render `BridgeErrorBanner`, `SyncSummary`, then `HistoryList` re-read from storage. A thrown `runSync` (e.g. no base URL) renders as an error alert — the button must return to enabled so the user can retry.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test`
Expected: PASS, every test across all files.

- [ ] **Step 8: Verify the build and type-check**

Run: `pnpm build && pnpm type-check`
Expected: both succeed; `dist/addon.js` written.

- [ ] **Step 9: End-to-end verification against a real instance**

Run `pnpm dev:server` and load the addon into a self-hosted Wealthfolio instance. Confirm by observation, not inference:
1. The sidebar entry appears before the addon boots (it comes from `contributes`).
2. Claiming a setup token stores credentials and shows the mapping table.
3. **Buttons respond** — this is the regression the `createRoot` prohibition exists to prevent.
4. A sync imports transactions that appear in Wealthfolio's activity list.
5. A second sync immediately after imports **zero** — the watermark works end to end.

Record the outcome of step 5 explicitly; it is the single most important behaviour in this plan and passing unit tests do not establish it.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add sync trigger, results, bridge errors and history UI"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Claim setup token, store access URL via `secrets` | 4, 9 |
| Account mapping UI (list, map, create, skip) | 9 |
| Manual "Sync now" trigger, no scheduler | 10 |
| Cash transactions → `checkImport` → `import` | 6 |
| Holdings → `snapshots.checkImport` → `importSnapshots` | 7 |
| Sync history persisted via `storage`, rendered in-addon | 5, 10 |
| Bridge error banner with dashboard link | 3, 10 |
| Balance-mismatch check | 8, 10 |
| Per-institution failure isolation | 8 |
| Watermark + recent-id idempotency | 5, 6 |
| `storage` size limits respected | 5 |
| Vitest with mocked `AddonContext`/`HostAPI` | 4 |
| Dev-server integration testing | 10 |

**Known gap, deliberately deferred:** the spec mentions creating Wealthfolio accounts on the spot (`accounts.create()`). Task 9 declares the permission and the mapping table has an "unmapped" state, but the create-account flow is described rather than fully specified. It is the smallest piece of v1 and depends on `AccountCreate` field requirements that should be read off the SDK at implementation time — treat it as an extension of Task 9, not a separate task.

**Type consistency:** `AccountRunResult`, `SyncRun`, `AccountMapping`, `SyncConfig`, and `Watermark` are each defined once (Task 5) and imported thereafter. `isoDate` is intentionally duplicated in `activities.ts` and `snapshots.ts` — two call sites do not justify a shared module; if a third appears, extract it then.
