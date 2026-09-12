/**
 * Index products have no trade feed, so they can never have CVD, and
 * confluenceEngine returns before scoring when CVD is not ready. They are
 * excluded from scoring explicitly — silence has to be deliberate, not the
 * shape of a quiet market (CLAUDE.md, silent zeros).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FEED_TICKERS, SCORED_TICKERS, NO_TRADE_FEED_TICKERS } from '../state/directionState.ts';
import { rebuildTicker } from '../session/cvdRebuild.ts';

afterEach(() => { vi.restoreAllMocks(); });

describe('index products', () => {
  it('stay in the feed (bars, chain, GEX) but are not in the scored set', () => {
    for (const t of ['SPX', 'NDX']) {
      expect(FEED_TICKERS as readonly string[]).toContain(t);
      expect(SCORED_TICKERS).not.toContain(t);
      expect(NO_TRADE_FEED_TICKERS.has(t)).toBe(true);
    }
    expect(SCORED_TICKERS.length).toBe(FEED_TICKERS.length - 2);
    expect(SCORED_TICKERS).toContain('SPY');
  });

  it('the CVD rebuild calls them none-needed, not absent — nothing is missing', async () => {
    const client = { fetchTradesPage: async () => { throw new Error('must not fetch for an index'); } } as never;
    const res = await rebuildTicker(client, 'SPX', 'stock', Date.UTC(2026, 7, 27, 15, 0, 0));
    expect(res.quality).toBe('none-needed');
    expect(res.reason).toMatch(/index product/);
  });
});
