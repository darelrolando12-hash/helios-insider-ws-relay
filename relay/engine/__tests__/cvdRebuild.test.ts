/**
 * Tests for mid-session CVD reconstruction.
 *
 * The single most important assertion here is that a rebuild which fetches
 * nothing reports quality 'absent' and NEVER presents as a real CVD of zero.
 * A zeroed CVD is neutral-looking and plausible, and confluenceEngine would
 * score 25 points against it with nothing indicating it is synthetic.
 */
import { describe, it, expect, vi } from 'vitest';
import { sessionOpenUtcMs, rebuildTicker, rebuildAll } from '../session/cvdRebuild.ts';
import { toCentralTime } from '../lib/time.ts';
import * as cvdStore from '../stores/cvdStore.ts';

function fakeClient(tradesByCall: unknown[][]) {
  let call = 0;
  return {
    fetchTradesSince: async () => (tradesByCall[call++] ?? []),
  } as never;
}

function throwingClient(message: string) {
  return {
    fetchTradesSince: async () => { throw new Error(message); },
  } as never;
}

describe('sessionOpenUtcMs', () => {
  it('resolves to 8:30 AM Central for a mid-session timestamp', () => {
    // 2026-08-27 14:00 UTC = 09:00 CDT.
    const now  = Date.UTC(2026, 7, 27, 14, 0, 0);
    const open = sessionOpenUtcMs(now);
    const ct   = toCentralTime(open);
    expect(ct.hour).toBe(8);
    expect(ct.minute).toBe(30);
  });

  it('is DST-correct — resolves to 8:30 CT in winter too, not a fixed offset', () => {
    // 2026-01-15 is CST (UTC-6); August is CDT (UTC-5). A fixed-offset
    // implementation would get one of these wrong.
    const winter = sessionOpenUtcMs(Date.UTC(2026, 0, 15, 16, 0, 0));
    const summer = sessionOpenUtcMs(Date.UTC(2026, 7, 27, 15, 0, 0));
    expect(toCentralTime(winter).hour).toBe(8);
    expect(toCentralTime(winter).minute).toBe(30);
    expect(toCentralTime(summer).hour).toBe(8);
    expect(toCentralTime(summer).minute).toBe(30);
  });

  it('never uses the host timezone — same CT result regardless of UTC input hour', () => {
    for (const hour of [13, 15, 18, 20]) {
      const ct = toCentralTime(sessionOpenUtcMs(Date.UTC(2026, 7, 27, hour, 0, 0)));
      expect(`${ct.hour}:${ct.minute}`).toBe('8:30');
    }
  });
});

describe('rebuildTicker — quality reporting', () => {
  it('reports quality=absent when zero trades are returned (NOT a ready zero)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await rebuildTicker(fakeClient([[]]), 'ZERO_A');

    expect(res.quality).toBe('absent');
    expect(res.ticksApplied).toBe(0);
    expect(res.reason).toMatch(/no trades/i);

    // The warning must name the risk explicitly, not just note emptiness.
    const logged = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toContain('quality=absent');
    expect(logged).toMatch(/not.*real|genuine zero/i);
    warn.mockRestore();
  });

  it('reports quality=absent when the fetch throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await rebuildTicker(throwingClient('upstream 500'), 'ZERO_B');
    expect(res.quality).toBe('absent');
    expect(res.reason).toMatch(/fetch failed/i);
    err.mockRestore();
  });

  it('reports quality=absent when every trade is unusable (zero price or size)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await rebuildTicker(
      fakeClient([[{ price: 0, size: 10, timestamp: 1 }, { price: 5, size: 0, timestamp: 2 }]]),
      'ZERO_C',
    );
    expect(res.quality).toBe('absent');
    expect(res.tradesFetched).toBe(2);
    expect(res.ticksApplied).toBe(0);
    warn.mockRestore();
  });

  it('reports quality=real and applies ticks when trades exist', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const now = Date.UTC(2026, 7, 27, 15, 0, 0);
    const res = await rebuildTicker(
      fakeClient([[
        { price: 400, size: 10, timestamp: now - 60_000 },
        { price: 401, size: 5,  timestamp: now - 30_000 },
        { price: 399, size: 8,  timestamp: now - 10_000 },
      ]]),
      'REAL_A', 'stock', now,
    );

    expect(res.quality).toBe('real');
    expect(res.tradesFetched).toBe(3);
    expect(res.ticksApplied).toBe(3);

    // Ticks landed in the store via the same write path live ticks use.
    const stored = cvdStore.getResult('REAL_A');
    expect(stored.status).toBe('ready');
    log.mockRestore();
  });

  it('always records that replay classified without quotes (the fidelity limit)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const now = Date.UTC(2026, 7, 27, 15, 0, 0);
    const res = await rebuildTicker(
      fakeClient([[{ price: 400, size: 10, timestamp: now - 60_000 }]]),
      'REAL_B', 'stock', now,
    );
    // This flag is the difference between replayed and live CVD; it must be
    // reported rather than smoothed over.
    expect(res.classifiedWithoutQuotes).toBe(true);
    log.mockRestore();
  });
});

describe('rebuildAll — summary', () => {
  it('counts real and absent separately and never conflates them', async () => {
    const log  = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err  = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now  = Date.UTC(2026, 7, 27, 15, 0, 0);

    // First ticker gets trades, second gets none.
    const client = fakeClient([
      [{ price: 400, size: 10, timestamp: now - 60_000 }],
      [],
    ]);

    const summary = await rebuildAll(client, ['SUM_A', 'SUM_B'], now);
    expect(summary.realCount).toBe(1);
    expect(summary.absentCount).toBe(1);
    expect(summary.results.find(r => r.ticker === 'SUM_B')!.quality).toBe('absent');

    // Any absent ticker must be escalated, not buried in an info log.
    const escalated = err.mock.calls.map(c => String(c[0])).join('\n');
    expect(escalated).toMatch(/absent/i);

    log.mockRestore(); err.mockRestore(); warn.mockRestore();
  });
});
