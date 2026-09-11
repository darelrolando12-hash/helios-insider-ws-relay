/**
 * cvdStore session scope — the 25-point CVD factor must be today's regular
 * session's flow, from the open. Before 2026-09-11 the totals were set once
 * per ticker and only ever added to: cumulative since the process booted.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as cvdStore from '../stores/cvdStore.ts';
import type { CvdTick } from '../stores/types.ts';

afterEach(() => { vi.useRealTimers(); });

// CT pseudo-epoch helpers (Sept = CDT, UTC−5).
const ct = (d: number, h: number, m: number) => Date.UTC(2026, 8, d, h, m);
const tick = (ticker: string, tCT: number, side: 'buy' | 'sell', size: number, price = 100): CvdTick =>
  ({ ticker, side, size, price, dollarFlow: (side === 'buy' ? 1 : -1) * price * size, tCT, tUtc: tCT + 5 * 3_600_000, assetClass: 'stock' });
const at = (tCT: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(tCT + 5 * 3_600_000); };
const net = (ticker: string) => { const r = cvdStore.getResult(ticker); return r.status === 'ready' ? r.data.netDelta : r.status; };

describe('cvdStore — session scope', () => {
  it('the first trade of a new session resets the totals (they used to run since boot)', () => {
    cvdStore.subscribeTicker('S1', 'stock');
    cvdStore.appendClassifiedTick('S1', tick('S1', ct(10, 9, 0), 'buy', 1_000));
    cvdStore.appendClassifiedTick('S1', tick('S1', ct(10, 14, 0), 'sell', 200));
    at(ct(10, 14, 30));
    expect(net('S1')).toBe(800);

    cvdStore.appendClassifiedTick('S1', tick('S1', ct(11, 8, 31), 'sell', 50));
    at(ct(11, 8, 32));
    expect(net('S1')).toBe(-50);
    const r = cvdStore.getResult('S1');
    expect(r.status === 'ready' && r.data.tickCount).toBe(1);
  });

  it("before today's first trade, yesterday's total is not served — it is loading", () => {
    cvdStore.subscribeTicker('S2', 'stock');
    cvdStore.appendClassifiedTick('S2', tick('S2', ct(10, 10, 0), 'buy', 500));
    at(ct(10, 15, 30));                 // same day, after the close: still that session's
    expect(net('S2')).toBe(500);
    at(ct(11, 8, 0));                   // next morning, pre-open
    expect(net('S2')).toBe('loading');
  });

  it('extended-hours trades are not session CVD, but still move the uptick reference', () => {
    cvdStore.subscribeTicker('S3', 'stock');
    cvdStore.appendClassifiedTick('S3', tick('S3', ct(11, 7, 0), 'buy', 9_999, 101.5));   // pre-market
    expect(cvdStore.getSpread('S3').prevPrice).toBe(101.5);
    at(ct(11, 7, 1));
    expect(net('S3')).toBe('loading');
    cvdStore.appendClassifiedTick('S3', tick('S3', ct(11, 8, 30), 'sell', 10));
    cvdStore.appendClassifiedTick('S3', tick('S3', ct(11, 15, 5), 'buy', 9_999));          // after-hours
    at(ct(11, 15, 6));
    expect(net('S3')).toBe(-10);
    expect(cvdStore.getDeltaBars('S3').map((b) => b.tCT)).toEqual([ct(11, 8, 30)]);
  });

  it('a replayed trade never becomes the live uptick reference', () => {
    cvdStore.subscribeTicker('S4', 'stock');
    cvdStore.appendClassifiedTick('S4', tick('S4', ct(11, 10, 0), 'buy', 1, 250));
    cvdStore.appendRebuiltTicks('S4', [tick('S4', ct(11, 9, 0), 'buy', 1, 240)]);
    expect(cvdStore.getSpread('S4').prevPrice).toBe(250);
  });

  it('replayed trades from before the live feed count; at or after it they are dropped', () => {
    cvdStore.subscribeTicker('S5', 'stock');
    cvdStore.appendClassifiedTick('S5', tick('S5', ct(11, 10, 0), 'buy', 5));
    const r = cvdStore.appendRebuiltTicks('S5', [
      tick('S5', ct(11, 9, 0), 'sell', 3),
      tick('S5', ct(11, 10, 0), 'buy', 5),     // the live trade itself, replayed
      tick('S5', ct(11, 10, 1), 'buy', 9),
    ]);
    expect(r).toEqual({ applied: 1, droppedAsLive: 2 });
    at(ct(11, 10, 2));
    expect(net('S5')).toBe(2);
  });
});
