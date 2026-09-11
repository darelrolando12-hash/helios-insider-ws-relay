/**
 * Session bias against the rebuilt flip level — the real updateDirectionState
 * path, with only the three stores it reads stubbed.
 *
 * SPY, 2026-09-10: price ~757.6 in a negative-gamma regime. The old flip was
 * $580, so the GEX vote was "NEG GEX above flip" (bullish +2) on every tick
 * of the day regardless of price. The rebuilt flip is $768.78 — price is
 * BELOW it, so the same vote is bearish. And when the flip is absent the
 * vote must not be cast at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  bars: [] as unknown[],
  flipLevel: null as number | null,
}));

vi.mock('../stores/barsStore.ts', () => ({
  getResult: () => ({ status: 'ready', data: state.bars, asOf: Date.now() }),
  getBarsRaw: () => state.bars,
  subscribe: () => () => {},
}));
vi.mock('../stores/cvdStore.ts', () => ({
  getResult: () => ({ status: 'ready', data: { callPct: 50, putPct: 50, netDelta: 0, classification: 'neutral', tickCount: 100 }, asOf: Date.now() }),
  subscribe: () => () => {},
}));
vi.mock('../stores/marketStore.ts', () => ({
  getResult: () => ({
    status: 'ready',
    data: { ticker: 'SPY', gexRegime: 'negative', walls: { callWall: 765, putWall: 755 }, flipLevel: state.flipLevel, asOf: Date.now() },
    asOf: Date.now(),
  }),
  subscribe: () => () => {},
}));

import { updateDirectionState, getDirectionState } from '../state/directionState.ts';

// 60 one-minute bars on 2026-09-10 from 08:30 CT, drifting 758.6 → 757.6, so
// price ends below session VWAP and below EMA55: both votes bearish, the
// GEX vote decides whether that nets to bearish or to neutral.
function spyLikeBars() {
  const t0 = Date.UTC(2026, 8, 10, 13, 30);
  return Array.from({ length: 60 }, (_, i) => {
    const c = 758.6 - i * (1.0 / 59);
    return { ticker: 'SPY', open: c, high: c + 0.05, low: c - 0.05, close: c, volume: 10_000,
      tUtc: t0 + i * 60_000, tCT: t0 - 5 * 3_600_000 + i * 60_000 };
  });
}

let n = 0;
beforeEach(() => { state.bars = spyLikeBars(); });

describe('session bias — GEX vote against the flip', () => {
  it('OLD flip ($580, far below price): votes "above flip" — bullish, whatever price does', () => {
    state.flipLevel = 580;
    const t = `SPY_${n++}`; updateDirectionState(t);
    const s = getDirectionState(t)!;
    expect(s.sessionBiasReason).toContain('NEG GEX above flip');
    expect(s.sessionBias).toBe('neutral'); // +2 bull vs +3 bear (VWAP, EMA55) nets −1
  });

  it('REBUILT flip ($768.78, above price): votes "below flip" — and the bias turns bearish', () => {
    state.flipLevel = 768.78;
    const t = `SPY_${n++}`; updateDirectionState(t);
    const s = getDirectionState(t)!;
    expect(s.sessionBiasReason).toContain('NEG GEX below flip');
    expect(s.sessionBias).toBe('bearish');
  });

  it('ABSENT flip: casts no GEX vote at all', () => {
    state.flipLevel = null;
    const t = `SPY_${n++}`; updateDirectionState(t);
    const s = getDirectionState(t)!;
    expect(s.sessionBiasReason).toContain('NEG GEX, flip absent');
    expect(s.sessionBiasReason).not.toMatch(/above flip|below flip/);
    expect(s.sessionBias).toBe('bearish'); // VWAP + EMA55 alone: −3
  });
});
