/**
 * /engine/gex — what every browser now reads instead of fetching whole
 * option chains itself. The payload must carry the engine's flip exactly as
 * computed, keep absent as absent (with its reason), and never drop age.
 */
import { describe, it, expect } from 'vitest';
import * as marketStore from '../stores/marketStore.ts';
import { gexSnapshot } from '../index.ts';
import type { MarketContext } from '../stores/marketStore.ts';

function ctx(ticker: string, flipLevel: number | null, flipAbsentReason: string | null, asOf: number): MarketContext {
  return {
    ticker, gexRegime: 'negative', walls: { callWall: 1, putWall: 1 }, flipLevel, flipAbsentReason,
    upTarget: 1, downTarget: 1, netGex: -1e9, pcRatio: 1, maxPain: 1, chain: [], asOf,
  } as MarketContext;
}

describe('gexSnapshot', () => {
  it('serves each ticker\'s flip exactly as the engine wrote it, absent included', () => {
    marketStore.writeContext('SPY', ctx('SPY', 768.78, null, 1_000));
    marketStore.writeContext('META', ctx('META', null, 'no zero crossing within ±15% of spot', 2_000));
    const snap = gexSnapshot();
    const byTicker = Object.fromEntries(snap.tickers.map((t) => [t.ticker, t]));
    expect(byTicker.SPY).toEqual({ ticker: 'SPY', flipLevel: 768.78, flipAbsentReason: null, gexRegime: 'negative', asOf: 1_000 });
    expect(byTicker.META.flipLevel).toBeNull();
    expect(byTicker.META.flipAbsentReason).toBe('no zero crossing within ±15% of spot');
    expect(snap.method).toMatch(/zeroGamma/);
  });
});
