/**
 * The gamma flip is the only model input that cannot be re-fetched for a past
 * day, so the forward log's row shape is worth pinning: absent stays absent,
 * the session date is Central, and the snapshot's age is carried so a stale
 * chain can be told from a fresh one later.
 */
import { describe, it, expect } from 'vitest';
import { buildRegimeRows, REGIME_LOG_INTERVAL_MS } from '../session/regimeLog.ts';
import type { MarketContext } from '../stores/marketStore.ts';

const ctx = (over: Partial<MarketContext>): MarketContext => ({
  ticker: 'SPY', spotPrice: 765.1, flipLevel: 770.4, flipAbsentReason: undefined,
  gexRegime: 'positive', walls: { callWall: 775, putWall: 755 }, asOf: Date.UTC(2026, 8, 11, 19, 55),
  ...over,
} as MarketContext);

// 2026-09-11 20:00Z = 15:00 CT — still the 11th in Central.
const NOW = Date.UTC(2026, 8, 11, 20, 0);

describe('buildRegimeRows', () => {
  it('records the flip, the walls and how old the chain snapshot was', () => {
    const [row] = buildRegimeRows([ctx({})], NOW);
    expect(row).toMatchObject({
      ticker: 'SPY', session_date: '2026-09-11', spot: 765.1, flip_level: 770.4,
      gex_regime: 'positive', call_wall: 775, put_wall: 755, snapshot_age_s: 300,
    });
    expect(row.observed_at).toBe('2026-09-11T20:00:00.000Z');
  });

  it('keeps an absent flip absent, with its reason — never a stand-in price', () => {
    const [row] = buildRegimeRows([ctx({ flipLevel: null, flipAbsentReason: 'no zero crossing within ±15% of spot', walls: { callWall: null, putWall: null } })], NOW);
    expect(row.flip_level).toBeNull();
    expect(row.flip_absent_reason).toBe('no zero crossing within ±15% of spot');
    expect(row.call_wall).toBeNull();
  });

  it('uses the Central session date, not the UTC one', () => {
    // 2026-09-12 02:00Z is still 2026-09-11 21:00 CT.
    const [row] = buildRegimeRows([ctx({})], Date.UTC(2026, 8, 12, 2, 0));
    expect(row.session_date).toBe('2026-09-11');
  });

  it('writes one row per ticker the engine actually holds, and none for an empty store', () => {
    expect(buildRegimeRows([ctx({}), ctx({ ticker: 'QQQ' })], NOW).map((r) => r.ticker)).toEqual(['SPY', 'QQQ']);
    expect(buildRegimeRows([], NOW)).toEqual([]);
  });

  it('logs at a cadence that covers a session without flooding the table', () => {
    expect(REGIME_LOG_INTERVAL_MS).toBe(300_000);
    expect((390 / 5) * 23).toBeLessThan(2_000);   // ~1,794 rows a day across 23 tickers
  });
});
