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
    activities: {
      checkImport: vi.fn(),
      import: vi.fn(),
      search: vi.fn(async () => ({ data: [], meta: { totalRowCount: 0 } })),
      update: vi.fn(async (activity: unknown) => activity),
    },
    snapshots: { checkImport: vi.fn(), importSnapshots: vi.fn() },
    portfolio: { recalculate: vi.fn(async () => {}) },
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
