#!/usr/bin/env node
/**
 * ONE-OFF REPAIR — delete this script once the instance is fixed.
 *
 * Activities pushed before `isoInstant()` existed went out as a bare
 * YYYY-MM-DD, which Wealthfolio's deserializer expanded to midnight UTC; its
 * frontend then renders that in the viewer's zone, one day early. The stored
 * *calendar date* is correct, so this is a pure time-of-day shift to noon UTC
 * on the same UTC date.
 *
 * The selection and field-mapping logic is imported from the addon's own
 * `src/lib/sync/repairDates.ts`, so the code that runs here is the code the
 * unit tests cover. Only the transport is different: this drives Wealthfolio's
 * REST API instead of the addon `HostAPI`.
 *
 * Usage:
 *   node scripts/repair-activity-dates.mjs --probe        # discover endpoints, no data read
 *   node scripts/repair-activity-dates.mjs --all-accounts # dry run: report what would change
 *   node scripts/repair-activity-dates.mjs --apply --only <activityId>
 *   node scripts/repair-activity-dates.mjs --apply --limit 1
 *   node scripts/repair-activity-dates.mjs --apply
 *
 * Credentials come from wf-simplefin's .env (WEALTHFOLIO_URL,
 * WEALTHFOLIO_PASSWORD, ACCOUNT_MAP) unless overridden by --url / --password /
 * --accounts. Secrets are never printed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyDateRepair, scanForMidnightUtcDates } from '../src/lib/sync/repairDates.ts';

const DEFAULT_ENV = '/Users/christianmendieta/Documents/git-clone/wf-simplefin/.env';
const PAGE_SIZE = 200;

function parseArgs(argv) {
  const args = { probe: false, apply: false, limit: undefined, env: DEFAULT_ENV };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--probe') args.probe = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--url') args.url = argv[++i];
    else if (arg === '--password') args.password = argv[++i];
    else if (arg === '--accounts') args.accounts = argv[++i].split(',').map((s) => s.trim());
    else if (arg === '--all-accounts') args.allAccounts = true;
    else if (arg === '--only') args.only = argv[++i];
    else if (arg === '--env') args.env = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    env[key.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

/**
 * ACCOUNT_MAP is either inline JSON or a path to a JSON file of sfId -> wfId.
 * A relative path is resolved against the .env's own directory, the way the
 * service that wrote it would read it — not against this repo's cwd.
 */
function wfAccountIdsFrom(accountMap, envPath) {
  if (!accountMap) return [];
  const raw = accountMap.trim().startsWith('{')
    ? accountMap
    : readFileSync(resolve(dirname(envPath), accountMap), 'utf8');
  return Object.values(JSON.parse(raw));
}

/** Minimal cookie-session client — Node's fetch does not persist cookies itself. */
function createClient(baseUrl) {
  let cookie = null;

  async function request(method, path, body) {
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    if (setCookie.length > 0) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    return response;
  }

  return { request };
}

async function login(client, baseUrl, password) {
  let response;
  try {
    response = await client.request('POST', '/api/v1/auth/login', { password });
  } catch (error) {
    // fetch collapses every transport failure into "fetch failed"; say which
    // host could not be reached so this isn't mistaken for a bad password.
    throw new Error(
      `Could not reach Wealthfolio at ${baseUrl} (${error.cause?.code ?? error.message}). ` +
        'Check the host is up and this machine is on the same network, or pass --url.',
    );
  }
  if (response.ok) return 'session';

  // An instance running with WF_AUTH_REQUIRED=false answers 404 here and
  // serves every route unauthenticated — not an error, just no session to get.
  const text = await response.text();
  if (response.status === 404 && text.includes('Authentication is not configured')) {
    return 'open';
  }
  throw new Error(`login failed: HTTP ${response.status} ${text}`);
}

/**
 * Wealthfolio's activity list/update endpoints are not exercised by any code
 * in this repo or its sibling, so they are discovered rather than assumed.
 * Prints what each candidate answers; nothing is written.
 */
const LIST_CANDIDATES = [
  ['GET', '/api/v1/activities?page=1&pageSize=1'],
  ['GET', '/api/v1/activities'],
  ['POST', '/api/v1/activities/search', { page: 0, pageSize: 1 }],
  ['GET', '/api/v1/activities/search?page=0&pageSize=1'],
];
const WRITE_CANDIDATES = [
  ['PUT', '/api/v1/activities/__probe__'],
  ['PATCH', '/api/v1/activities/__probe__'],
  ['POST', '/api/v1/activities/bulk'],
  ['POST', '/api/v1/activities/save-many'],
];

async function probe(client) {
  console.log('\n-- list candidates (read-only) --');
  for (const [method, path, body] of LIST_CANDIDATES) {
    try {
      const response = await client.request(method, path, body);
      const text = await response.text();
      console.log(`${method} ${path} -> ${response.status} ${text.slice(0, 160)}`);
    } catch (error) {
      console.log(`${method} ${path} -> ${error.message}`);
    }
  }
  console.log('\n-- write candidates (probing route existence only; no valid payload sent) --');
  for (const [method, path] of WRITE_CANDIDATES) {
    try {
      const response = await client.request(method, path, {});
      const text = await response.text();
      // 404 means no such route; 4xx-validation means the route exists.
      console.log(`${method} ${path} -> ${response.status} ${text.slice(0, 160)}`);
    } catch (error) {
      console.log(`${method} ${path} -> ${error.message}`);
    }
  }
  console.log('\nRe-run without --probe once the working list/update routes are known.');
}

/**
 * Adapts the REST API to the `RepairHost` shape `repairDates.ts` expects, so
 * the selection and field-mapping logic is shared with the addon and its tests.
 *
 * Routes confirmed against a live instance via --probe:
 *   POST /api/v1/activities/search -> { data, meta: { totalRowCount } }
 *   POST /api/v1/activities/bulk   -> ActivityBulkMutationResult
 * (GET /api/v1/activities answers 405 — search is POST-only.)
 */
function createRepairHost(client) {
  return {
    activities: {
      async search(page, pageSize, filters) {
        const response = await client.request('POST', '/api/v1/activities/search', {
          page,
          pageSize,
          ...(filters.accountIds ? { accountIds: filters.accountIds } : {}),
        });
        if (!response.ok) {
          throw new Error(`search failed: HTTP ${response.status} ${await response.text()}`);
        }
        const payload = await response.json();
        return {
          data: payload.data ?? [],
          meta: { totalRowCount: payload.meta?.totalRowCount ?? (payload.data ?? []).length },
        };
      },
      async saveMany({ updates }) {
        const response = await client.request('POST', '/api/v1/activities/bulk', { updates });
        if (!response.ok) {
          const text = await response.text();
          // A transport-level rejection fails the whole batch, so attribute it
          // to every row in it rather than silently reporting zero errors.
          return { errors: updates.map((u) => ({ id: u.id, message: `HTTP ${response.status} ${text}` })) };
        }
        const result = await response.json();
        return { errors: result.errors ?? [] };
      },
    },
    logger: {
      error: (message) => console.error(message),
      info: (message) => console.log(message),
    },
  };
}

/** Every account on the instance, for when no explicit scope is given. */
async function allAccountIds(client) {
  const response = await client.request('GET', '/api/v1/accounts');
  if (!response.ok) throw new Error(`accounts failed: HTTP ${response.status}`);
  const payload = await response.json();
  return (Array.isArray(payload) ? payload : (payload.data ?? [])).map((a) => a.id);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv(args.env);
  const baseUrl = (args.url ?? env.WEALTHFOLIO_URL ?? '').replace(/\/$/, '');
  const password = args.password ?? env.WEALTHFOLIO_PASSWORD ?? '';
  if (!baseUrl) throw new Error('No Wealthfolio URL — set WEALTHFOLIO_URL or pass --url');

  const client = createClient(baseUrl);
  const auth = await login(client, baseUrl, password);
  console.log(`Connected (${auth === 'open' ? 'no auth configured' : 'logged in'}).`);

  if (args.probe) return probe(client);

  // --accounts, else wf-simplefin's ACCOUNT_MAP, else every account on the
  // instance. The ACCOUNT_MAP fallback is stale against this instance (its ids
  // match no account here), so --all-accounts is the usable scope in practice.
  const accountIds =
    args.accounts ??
    (args.allAccounts ? await allAccountIds(client) : wfAccountIdsFrom(env.ACCOUNT_MAP, args.env));
  if (accountIds.length === 0) {
    throw new Error('No accounts in scope — pass --accounts or --all-accounts');
  }
  console.log(`${accountIds.length} account(s) in scope.`);

  const host = createRepairHost(client);
  let found = await scanForMidnightUtcDates(host, accountIds);

  // --only narrows to one activity id, so the first write of a run can be
  // aimed at a specific row (e.g. a transfer leg carrying sourceGroupId)
  // rather than whatever happens to sort first.
  if (args.only) {
    found = found.filter((repair) => repair.id === args.only);
    if (found.length === 0) throw new Error(`--only ${args.only} matched no repairable activity`);
  }

  console.log(`\n${found.length} activit${found.length === 1 ? 'y' : 'ies'} stored at midnight UTC:`);
  for (const repair of found.slice(0, 20)) {
    console.log(
      `  ${repair.accountName.padEnd(24)} ${repair.comment.slice(0, 28).padEnd(28)} ` +
        `${String(repair.amount).padStart(12)}   ${repair.from} -> ${repair.to}`,
    );
  }
  if (found.length > 20) console.log(`  ...and ${found.length - 20} more`);

  if (!args.apply) {
    console.log('\nDry run — nothing was changed. Re-run with --apply --limit 1 to repair one row.');
    return;
  }

  const result = await applyDateRepair(host, found, { limit: args.limit });
  console.log(`\nRepaired ${result.repaired}, failed ${result.failed.length}.`);
  for (const failure of result.failed.slice(0, 10)) {
    console.log(`  FAILED ${failure.id}: ${failure.error}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
