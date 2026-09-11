/**
 * The per-minute delta series — what replaces the chart's synthetic CVD ramp
 * and what the exhaustion exit will read.
 */
import { describe, it, expect } from 'vitest';
import * as cvdStore from '../stores/cvdStore.ts';
import type { CvdTick } from '../stores/types.ts';

// CT pseudo-epoch minutes on 2026-09-10 and 2026-09-11.
const D10 = Date.UTC(2026, 8, 10, 8, 30);
const D11 = Date.UTC(2026, 8, 11, 8, 30);
const tick = (tCT: number, side: 'buy' | 'sell', size: number): CvdTick =>
  ({ ticker: 'TST', side, size, price: 100, dollarFlow: side === 'buy' ? 100 * size : -100 * size, tCT, tUtc: tCT + 5 * 3_600_000, assetClass: 'stock' });

describe('cvdStore.getDeltaBars', () => {
  it('buckets classified volume per minute with a running session total', () => {
    cvdStore.subscribeTicker('TST', 'stock');
    cvdStore.appendClassifiedTick('TST', tick(D10 + 5_000, 'buy', 300));
    cvdStore.appendClassifiedTick('TST', tick(D10 + 40_000, 'sell', 100));
    // minute 2 has no trades — it must be ABSENT, not a zero bar
    cvdStore.appendClassifiedTick('TST', tick(D10 + 2 * 60_000 + 1_000, 'sell', 500));
    const bars = cvdStore.getDeltaBars('TST');
    expect(bars).toEqual([
      { tCT: D10,              buy: 300, sell: 100, delta: 200,  cumDelta: 200 },
      { tCT: D10 + 2 * 60_000, buy: 0,   sell: 500, delta: -500, cumDelta: -300 },
    ]);
  });

  it('returns only the newest CT session, and its total starts from zero', () => {
    cvdStore.appendClassifiedTick('TST', tick(D11 + 10_000, 'buy', 50));
    const bars = cvdStore.getDeltaBars('TST');
    expect(bars).toEqual([{ tCT: D11, buy: 50, sell: 0, delta: 50, cumDelta: 50 }]);
  });

  it('is empty — not a fabricated series — for a ticker with no ticks', () => {
    expect(cvdStore.getDeltaBars('NOPE')).toEqual([]);
  });
});
