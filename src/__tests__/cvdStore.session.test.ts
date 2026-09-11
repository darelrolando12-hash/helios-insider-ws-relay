/**
 * Browser cvdStore session scope — same rule as the engine's
 * (relay/engine/__tests__/cvdStore.session.test.ts). The browser engine
 * still writes signals, so its CVD must be today's session too.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as cvdStore from '../stores/cvdStore';
import type { CvdTick } from '../stores/types';

afterEach(() => { vi.useRealTimers(); });

const ct = (d: number, h: number, m: number) => Date.UTC(2026, 8, d, h, m);
const tick = (tCT: number, side: 'buy' | 'sell', size: number): CvdTick =>
  ({ ticker: 'B1', side, size, price: 100, dollarFlow: (side === 'buy' ? 100 : -100) * size, tCT, tUtc: tCT + 5 * 3_600_000, assetClass: 'stock' });
const net = (at: number) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at + 5 * 3_600_000);
  const r = cvdStore.getResult('B1');
  return r.status === 'ready' ? r.data.netDelta : r.status;
};

describe('browser cvdStore — session scope', () => {
  it('resets at the next session, ignores extended hours, and never serves yesterday pre-open', () => {
    cvdStore.subscribeTicker('B1', 'stock');
    cvdStore.appendClassifiedTick('B1', tick(ct(10, 9, 0), 'buy', 1_000));
    cvdStore.appendClassifiedTick('B1', tick(ct(10, 15, 30), 'sell', 9_999));   // after-hours
    expect(net(ct(10, 15, 31))).toBe(1_000);
    expect(net(ct(11, 8, 0))).toBe('loading');
    cvdStore.appendClassifiedTick('B1', tick(ct(11, 8, 30), 'sell', 40));
    expect(net(ct(11, 8, 31))).toBe(-40);
  });
});
