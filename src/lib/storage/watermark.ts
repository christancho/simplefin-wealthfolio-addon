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
