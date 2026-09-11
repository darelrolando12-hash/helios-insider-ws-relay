/**
 * Tests for the session CVD rebuild.
 *
 * The single most important assertion here is that a rebuild which fetches
 * nothing reports quality 'absent' and NEVER presents as a real CVD of zero.
 * A zeroed CVD is neutral-looking and plausible, and confluenceEngine would
 * score 25 points against it with nothing indicating it is synthetic. The
 * 2026-09-11 rewrite adds: page through next_url to the end, report a capped
 * rebuild as 'partial', and never count a trade the live feed already did.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sessionOpenUtcMs, rebuildTicker, rebuildAll } from '../session/cvdRebuild.ts';
import { toCentralTime } from '../lib/time.ts';
import * as cvdStore from '../stores/cvdStore.ts';
import type { CvdTick } from '../stores/types.ts';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// Thursday 2026-08-27, 10:00 CDT — mid-session. Open = 13:30Z.
const NOW  = Date.UTC(2026, 7, 27, 15, 0, 0);
const OPEN = Date.UTC(2026, 7, 27, 13, 30, 0);

type Trade = { price: number; size: number; timestamp: number };

/** A fake client that serves `pages` in order via next cursors, recording the first request's range. */
function pagedClient(pages: Trade[][]) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      fetchTradesPage: async (_t: string, range: unknown) => {
        calls.push(range);
        const i = 'cursor' in (range as object) ? Number((range as { cursor: string }).cursor) : 0;
        return { trades: pages[i] ?? [], next: i + 1 < pages.length ? String(i + 1) : null };
      },
    } as never,
  };
}

function throwingClient(message: string) {
  return { fetchTradesPage: async () => { throw new Error(message); } } as never;
}

const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
};

describe('sessionOpenUtcMs', () => {
  it('resolves to 8:30 AM Central for a mid-session timestamp', () => {
    const ct = toCentralTime(sessionOpenUtcMs(NOW));
    expect(ct.hour).toBe(8);
    expect(ct.minute).toBe(30);
  });

  it('is DST-correct — resolves to 8:30 CT in winter too, not a fixed offset', () => {
    const winter = sessionOpenUtcMs(Date.UTC(2026, 0, 15, 16, 0, 0));
    const summer = sessionOpenUtcMs(Date.UTC(2026, 7, 27, 15, 0, 0));
    expect(`${toCentralTime(winter).hour}:${toCentralTime(winter).minute}`).toBe('8:30');
    expect(`${toCentralTime(summer).hour}:${toCentralTime(summer).minute}`).toBe('8:30');
  });

  it('never uses the host timezone — same CT result regardless of UTC input hour', () => {
    for (const hour of [13, 15, 18, 20]) {
      const ct = toCentralTime(sessionOpenUtcMs(Date.UTC(2026, 7, 27, hour, 0, 0)));
      expect(`${ct.hour}:${ct.minute}`).toBe('8:30');
    }
  });
});

describe('rebuildTicker — range and paging', () => {
  it('asks for [open, now) and follows next cursors to the end', async () => {
    quiet();
    const { client, calls } = pagedClient([
      [{ price: 400, size: 10, timestamp: OPEN + 1_000 }],
      [{ price: 401, size: 5, timestamp: OPEN + 60_000 }],
      [{ price: 399, size: 8, timestamp: OPEN + 120_000 }],
    ]);
    const res = await rebuildTicker(client, 'PAGE_A', 'stock', NOW);
    expect(calls[0]).toEqual({ fromUtcMs: OPEN, toUtcMs: NOW });
    expect(calls.slice(1)).toEqual([{ cursor: '1' }, { cursor: '2' }]);
    expect(res).toMatchObject({ quality: 'real', pages: 3, tradesFetched: 3, ticksApplied: 3 });
  });

  it('after the close asks only for the regular session, never after-hours', async () => {
    quiet();
    const { client, calls } = pagedClient([[{ price: 400, size: 10, timestamp: OPEN + 1_000 }]]);
    const evening = Date.UTC(2026, 7, 27, 23, 0, 0); // 18:00 CDT
    await rebuildTicker(client, 'PAGE_B', 'stock', evening);
    expect(calls[0]).toEqual({ fromUtcMs: OPEN, toUtcMs: OPEN + 390 * 60_000 });
  });

  it('reports partial — not real — when it stops at the page cap', async () => {
    quiet();
    const { client } = pagedClient([
      [{ price: 400, size: 10, timestamp: OPEN + 1_000 }],
      [{ price: 401, size: 5, timestamp: OPEN + 60_000 }],
      [{ price: 399, size: 8, timestamp: OPEN + 120_000 }],
    ]);
    const res = await rebuildTicker(client, 'PAGE_C', 'stock', NOW, { maxPages: 2 });
    expect(res.quality).toBe('partial');
    expect(res.reason).toMatch(/page cap/);
    expect(cvdStore.getCoverage('PAGE_C')).toMatchObject({ complete: false, rebuiltToUtc: OPEN + 60_000 });
  });

  it('drops every replayed trade at or after the first live trade, and stops fetching', async () => {
    quiet();
    cvdStore.subscribeTicker('LIVE_A', 'stock');
    const liveTick: CvdTick = { ticker: 'LIVE_A', side: 'buy', size: 7, price: 402, dollarFlow: 2814,
      tCT: OPEN + 90_000 - 5 * 3_600_000, tUtc: OPEN + 90_000, assetClass: 'stock' };
    cvdStore.appendClassifiedTick('LIVE_A', liveTick);
    const { client, calls } = pagedClient([
      [{ price: 400, size: 10, timestamp: OPEN + 1_000 }, { price: 401, size: 5, timestamp: OPEN + 90_000 }],
      [{ price: 399, size: 8, timestamp: OPEN + 120_000 }],
    ]);
    const res = await rebuildTicker(client, 'LIVE_A', 'stock', NOW);
    expect(res).toMatchObject({ quality: 'real', ticksApplied: 1, droppedAsLive: 1, pages: 1 });
    expect(calls).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const r = cvdStore.getResult('LIVE_A');
    expect(r.status === 'ready' && r.data.netDelta).toBe(17); // live 7 + replayed 10; the 5 at 90 s was live's
  });
});

describe('rebuildTicker — quality reporting', () => {
  it('reports quality=absent when zero trades are returned (NOT a ready zero)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await rebuildTicker(pagedClient([[]]).client, 'ZERO_A', 'stock', NOW);
    expect(res.quality).toBe('absent');
    expect(res.ticksApplied).toBe(0);
    expect(res.reason).toMatch(/no trades/i);
    const logged = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toContain('quality=absent');
    expect(logged).toMatch(/not.*real|genuine zero/i);
  });

  it('reports quality=absent when the fetch throws', async () => {
    quiet();
    const res = await rebuildTicker(throwingClient('upstream 500'), 'ZERO_B', 'stock', NOW);
    expect(res.quality).toBe('absent');
    expect(res.reason).toMatch(/fetch failed/i);
  });

  it('reports quality=absent when every trade is unusable (zero price or size)', async () => {
    quiet();
    const res = await rebuildTicker(
      pagedClient([[{ price: 0, size: 10, timestamp: OPEN + 1 }, { price: 5, size: 0, timestamp: OPEN + 2 }]]).client,
      'ZERO_C', 'stock', NOW,
    );
    expect(res).toMatchObject({ quality: 'absent', tradesFetched: 2, ticksApplied: 0 });
  });

  it('reports none-needed before the open and on a weekend — nothing is missing', async () => {
    quiet();
    const preOpen  = await rebuildTicker(pagedClient([]).client, 'PRE_A', 'stock', Date.UTC(2026, 7, 27, 12, 0, 0));
    const saturday = await rebuildTicker(pagedClient([]).client, 'SAT_A', 'stock', Date.UTC(2026, 7, 29, 16, 0, 0));
    expect(preOpen.quality).toBe('none-needed');
    expect(saturday.quality).toBe('none-needed');
    expect(saturday.reason).toMatch(/weekend/);
  });

  it('reports quality=real and the ticks reach the store', async () => {
    quiet();
    const res = await rebuildTicker(
      pagedClient([[
        { price: 400, size: 10, timestamp: NOW - 60_000 },
        { price: 401, size: 5,  timestamp: NOW - 30_000 },
        { price: 399, size: 8,  timestamp: NOW - 10_000 },
      ]]).client,
      'REAL_A', 'stock', NOW,
    );
    expect(res).toMatchObject({ quality: 'real', tradesFetched: 3, ticksApplied: 3, classifiedWithoutQuotes: true });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    expect(cvdStore.getResult('REAL_A').status).toBe('ready');
  });
});

describe('rebuildAll — summary', () => {
  it('counts real and absent separately and never conflates them', async () => {
    quiet();
    const err = console.error as unknown as ReturnType<typeof vi.fn>;
    let call = 0;
    const client = {
      fetchTradesPage: async () => ({ trades: call++ === 0 ? [{ price: 400, size: 10, timestamp: NOW - 60_000 }] : [], next: null }),
    } as never;
    const summary = await rebuildAll(client, ['SUM_A', 'SUM_B'], NOW, { liveWaitMs: 0 });
    expect(summary.realCount).toBe(1);
    expect(summary.absentCount).toBe(1);
    expect(summary.results.find(r => r.ticker === 'SUM_B')!.quality).toBe('absent');
    expect(err.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/absent/i);
  });
});
