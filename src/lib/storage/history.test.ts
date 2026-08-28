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
