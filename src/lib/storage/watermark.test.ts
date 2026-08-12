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
